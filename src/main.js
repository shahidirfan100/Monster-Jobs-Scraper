import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';
import * as cheerio from 'cheerio';
import { gotScraping } from 'got-scraping';

// Initialize the Apify SDK
await Actor.init();

/**
 * Extract jobs from JSON-LD structured data (Primary method)
 * Monster.com uses JobPosting schema
 */
async function extractJobsViaJsonLD(page) {
    log.info('Attempting to extract jobs via JSON-LD');

    try {
        const jsonLdScripts = await page.$$eval('script[type="application/ld+json"]', scripts =>
            scripts.map(script => script.textContent)
        );

        const jobs = [];

        for (const scriptContent of jsonLdScripts) {
            try {
                const data = JSON.parse(scriptContent);

                // Handle array of job postings
                if (Array.isArray(data)) {
                    for (const item of data) {
                        if (item['@type'] === 'JobPosting') {
                            jobs.push(parseJobPosting(item));
                        }
                    }
                }
                // Handle single job posting
                else if (data['@type'] === 'JobPosting') {
                    jobs.push(parseJobPosting(data));
                }
                // Handle @graph structure
                else if (data['@graph']) {
                    for (const item of data['@graph']) {
                        if (item['@type'] === 'JobPosting') {
                            jobs.push(parseJobPosting(item));
                        }
                    }
                }
                // Handle ItemList with job postings
                else if (data['@type'] === 'ItemList' && data.itemListElement) {
                    for (const listItem of data.itemListElement) {
                        const item = listItem.item || listItem;
                        if (item['@type'] === 'JobPosting') {
                            jobs.push(parseJobPosting(item));
                        }
                    }
                }
            } catch (parseErr) {
                log.debug(`Failed to parse JSON-LD: ${parseErr.message}`);
            }
        }

        if (jobs.length > 0) {
            log.info(`Extracted ${jobs.length} jobs via JSON-LD`);
        }

        return jobs;
    } catch (error) {
        log.warning(`JSON-LD extraction failed: ${error.message}`);
        return [];
    }
}

/**
 * Parse JobPosting schema to our format
 */
function parseJobPosting(jobData) {
    const hiringOrg = jobData.hiringOrganization || {};
    const jobLocation = jobData.jobLocation || {};
    const address = jobLocation.address || {};

    let location = '';
    if (typeof address === 'string') {
        location = address;
    } else {
        location = [
            address.addressLocality,
            address.addressRegion,
            address.addressCountry
        ].filter(Boolean).join(', ');
    }

    let salary = 'Not specified';
    if (jobData.baseSalary) {
        const baseSalary = jobData.baseSalary;
        if (baseSalary.value) {
            const value = baseSalary.value;
            if (typeof value === 'object') {
                salary = `${value.minValue || ''} - ${value.maxValue || ''} ${baseSalary.currency || ''}`.trim();
            } else {
                salary = `${value} ${baseSalary.currency || ''}`.trim();
            }
        }
    }

    return {
        title: jobData.title || '',
        company: hiringOrg.name || '',
        location: location,
        salary: salary,
        jobType: jobData.employmentType || 'Not specified',
        postedDate: jobData.datePosted || '',
        descriptionHtml: jobData.description || '',
        descriptionText: jobData.description ? stripHtml(jobData.description) : '',
        url: jobData.url || '',
        scrapedAt: new Date().toISOString()
    };
}

/**
 * Strip HTML tags from string
 */
function stripHtml(html) {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Intercept and capture Monster.com API requests for job data
 * This is the PRIMARY and FASTEST method
 */
async function setupAPIInterceptor(page) {
    const capturedJobs = [];

    // Set up response interceptor to capture API calls
    page.on('response', async (response) => {
        const url = response.url();
        
        // Monster.com API endpoints patterns
        if (url.includes('/job-search/') || 
            url.includes('/jobsearch') || 
            url.includes('/api/search') ||
            url.includes('query=') && url.includes('where=')) {
            
            try {
                const contentType = response.headers()['content-type'] || '';
                
                if (contentType.includes('application/json')) {
                    const data = await response.json();
                    
                    // Extract jobs from various API response structures
                    let jobArray = null;
                    
                    if (data.jobResults) jobArray = data.jobResults;
                    else if (data.docs) jobArray = data.docs;
                    else if (data.results) jobArray = data.results;
                    else if (data.data?.jobs) jobArray = data.data.jobs;
                    else if (Array.isArray(data)) jobArray = data;
                    
                    if (jobArray && Array.isArray(jobArray)) {
                        log.info(`Intercepted API response with ${jobArray.length} jobs from: ${url.substring(0, 100)}`);
                        capturedJobs.push(...jobArray);
                    }
                }
            } catch (err) {
                log.debug(`Failed to parse API response: ${err.message}`);
            }
        }
    });

    return capturedJobs;
}

/**
 * Extract jobs from Monster.com using direct HTTP API call
 * Faster than browser automation - PRIMARY METHOD
 */
async function extractJobsViaDirectAPI(searchQuery, location, page = 1) {
    log.info('Attempting direct Monster.com API extraction');

    try {
        // Monster.com search API endpoint (reverse-engineered)
        const apiUrl = new URL('https://www.monster.com/jobs/search');
        apiUrl.searchParams.append('q', searchQuery);
        if (location) apiUrl.searchParams.append('where', location);
        apiUrl.searchParams.append('page', page.toString());

        const response = await gotScraping({
            url: apiUrl.toString(),
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.monster.com/',
            },
            timeout: { request: 15000 },
            retry: { limit: 2 },
        });

        if (response.statusCode === 200) {
            // Try parsing as JSON first
            try {
                const data = JSON.parse(response.body);
                log.info('Successfully fetched data via direct API');
                
                // Extract job array
                let jobArray = null;
                if (data.jobResults) jobArray = data.jobResults;
                else if (data.docs) jobArray = data.docs;
                else if (data.results) jobArray = data.results;
                
                if (jobArray && Array.isArray(jobArray)) {
                    return jobArray;
                }
            } catch {
                // If not JSON, continue to HTML parsing
                log.debug('Response is not JSON, will parse as HTML');
            }
        }

        return [];
    } catch (error) {
        log.warning(`Direct API extraction failed: ${error.message}`);
        return [];
    }
}

/**
 * Extract jobs from Monster.com internal JSON API embedded in page
 */
async function extractJobsViaMonsterAPI(page) {
    log.info('Attempting to extract jobs via Monster embedded API');

    try {
        const apiData = await page.evaluate(() => {
            // Check for Next.js data (Monster uses Next.js)
            if (window.__NEXT_DATA__) {
                return { type: 'nextjs', data: JSON.stringify(window.__NEXT_DATA__) };
            }
            
            // Check for React/Redux initial state
            if (window.__INITIAL_STATE__) {
                return { type: 'redux', data: JSON.stringify(window.__INITIAL_STATE__) };
            }

            // Check for window.APP_DATA or similar
            if (window.APP_DATA) {
                return { type: 'appdata', data: JSON.stringify(window.APP_DATA) };
            }

            // Check for embedded JSON in scripts
            const scripts = document.querySelectorAll('script:not([src])');
            for (const script of scripts) {
                const content = script.textContent || '';
                // Look for job data patterns
                if (content.includes('jobResults') || 
                    content.includes('searchResults') || 
                    content.includes('"docs":[{') ||
                    content.includes('__NEXT_DATA__')) {
                    return { type: 'script', data: content };
                }
            }

            return null;
        });

        if (!apiData) {
            log.debug('No embedded API data found in page');
            return [];
        }

        log.info(`Found embedded API data of type: ${apiData.type}`);

        const jobs = [];

        try {
            let data;
            
            // Extract JSON from script content if needed
            if (apiData.type === 'script') {
                // Try to find JSON object in script
                const jsonMatch = apiData.data.match(/(__NEXT_DATA__|window\.__NEXT_DATA__)\s*=\s*(\{.*?\});?/s);
                if (jsonMatch) {
                    data = JSON.parse(jsonMatch[2]);
                } else {
                    // Try direct JSON parse
                    data = JSON.parse(apiData.data);
                }
            } else {
                data = JSON.parse(apiData.data);
            }

            // Navigate through Next.js data structure
            let jobArray = null;

            if (data.props?.pageProps?.jobs) {
                jobArray = data.props.pageProps.jobs;
            } else if (data.props?.pageProps?.searchResults?.docs) {
                jobArray = data.props.pageProps.searchResults.docs;
            } else if (data.props?.pageProps?.initialJobs) {
                jobArray = data.props.pageProps.initialJobs;
            } else if (data.jobResults) {
                jobArray = data.jobResults;
            } else if (data.searchResults?.docs) {
                jobArray = data.searchResults.docs;
            } else if (data.docs) {
                jobArray = data.docs;
            } else if (data.results) {
                jobArray = data.results;
            }

            if (jobArray && Array.isArray(jobArray) && jobArray.length > 0) {
                log.info(`Found ${jobArray.length} jobs in embedded API data`);

                for (const job of jobArray) {
                    const jobUrl = job.jobUrl || job.url || job.applyUrl || 
                                  job.jobViewUrl || job.detailUrl ||
                                  (job.jobId ? `https://www.monster.com/job-openings/${job.jobId}` : '');

                    // Extract location from various formats
                    let location = job.location || job.jobLocation || job.city || '';
                    if (typeof location === 'object') {
                        location = [location.city, location.state, location.country].filter(Boolean).join(', ');
                    }

                    jobs.push({
                        title: job.title || job.jobTitle || job.name || '',
                        company: job.company || job.companyName || job.hiringCompany || job.companyDisplayName || '',
                        location,
                        salary: job.salary || job.compensation || job.estimatedSalary || 'Not specified',
                        jobType: job.jobType || job.employmentType || job.type || 'Not specified',
                        postedDate: job.postedDate || job.datePosted || job.listedDate || job.postedAt || '',
                        descriptionHtml: job.description || job.jobDescription || job.snippet || '',
                        descriptionText: stripHtml(job.description || job.jobDescription || job.snippet || ''),
                        url: jobUrl,
                        scrapedAt: new Date().toISOString()
                    });
                }
            }
        } catch (parseErr) {
            log.warning(`Failed to parse embedded API data: ${parseErr.message}`);
            log.debug(`Data type: ${apiData.type}, Data preview: ${apiData.data.substring(0, 500)}`);
        }

        if (jobs.length > 0) {
            log.info(`Extracted ${jobs.length} jobs via embedded Monster API`);
        }

        return jobs;
    } catch (error) {
        log.warning(`Monster embedded API extraction failed: ${error.message}`);
        return [];
    }
}

/**
 * Fetch complete job description from detail page using got-scraping
 * Uses cookies from Camoufox session to maintain Cloudflare bypass
 */
async function fetchFullDescription(jobUrl, cookies = '', userAgent = '') {
    try {
        const response = await gotScraping({
            url: jobUrl,
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cookie': cookies,
                'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
            },
            timeout: { request: 15000 },
            retry: { limit: 1 },
        });

        if (response.statusCode === 403 || response.statusCode === 503) {
            log.debug(`Cloudflare block detected on detail page (${response.statusCode}): ${jobUrl}`);
            return { blocked: true };
        }

        if (response.statusCode !== 200) {
            log.debug(`Detail page returned status ${response.statusCode}: ${jobUrl}`);
            return null;
        }

        const $ = cheerio.load(response.body);

        const title = $('title').text();
        if (title.includes('Just a moment') || title.includes('Cloudflare')) {
            log.debug(`Cloudflare challenge page detected: ${jobUrl}`);
            return { blocked: true };
        }

        // Monster.com job detail selectors
        const descriptionSelectors = [
            '[data-testid="jobDescription"]',
            '#JobDescription',
            '.job-description',
            '[id*="jobdescription"]',
            '[class*="job-description"]',
            'section.description',
            '.description-content',
            '[data-cy="jobDescription"]',
            'div[role="region"]'
        ];

        let descriptionHtml = '';
        let descriptionText = '';

        for (const selector of descriptionSelectors) {
            const descEl = $(selector).clone();
            if (descEl.length && descEl.text().trim().length > 100) {
                descriptionHtml = descEl.html()?.trim() || '';
                descriptionText = descEl.text().trim();
                break;
            }
        }

        // Extract job type if available
        const jobType = $('[data-testid="employmentType"], .job-type, [class*="employment"]').first().text().trim() || '';

        if (descriptionText && descriptionText.length > 50) {
            return {
                descriptionHtml,
                descriptionText,
                jobType: jobType || null,
            };
        }

        return null;
    } catch (error) {
        if (error.message && (error.message.includes('403') || error.message.includes('503'))) {
            log.debug(`Cloudflare block detected (error): ${jobUrl}`);
            return { blocked: true };
        }
        log.debug(`Failed to fetch detail page ${jobUrl}: ${error.message}`);
        return null;
    }
}

/**
 * Enrich jobs with full descriptions from detail pages
 */
async function enrichJobsWithFullDescriptions(jobs, page, maxConcurrency = 10) {
    if (jobs.length === 0) return jobs;

    log.info(`Fetching full descriptions for ${jobs.length} jobs...`);

    const cookies = await page.context().cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const userAgent = await page.evaluate(() => navigator.userAgent);

    log.debug(`Using ${cookies.length} cookies from Camoufox session for detail pages`);

    const enrichedJobs = [];
    const batchSize = maxConcurrency;
    let blockedCount = 0;

    for (let i = 0; i < jobs.length; i += batchSize) {
        const batch = jobs.slice(i, i + batchSize);

        const batchPromises = batch.map(async (job) => {
            if (!job.url) return job;

            const fullDesc = await fetchFullDescription(job.url, cookieString, userAgent);

            if (fullDesc && fullDesc.blocked) {
                blockedCount++;
                log.warning(`Detail page blocked by Cloudflare: ${job.url}`);
                return job;
            }

            if (fullDesc && fullDesc.descriptionHtml) {
                return {
                    ...job,
                    descriptionHtml: fullDesc.descriptionHtml,
                    descriptionText: fullDesc.descriptionText,
                    jobType: fullDesc.jobType || job.jobType,
                };
            }

            return job;
        });

        const batchResults = await Promise.all(batchPromises);
        enrichedJobs.push(...batchResults);

        log.info(`Enriched ${Math.min(i + batchSize, jobs.length)}/${jobs.length} jobs with full descriptions`);

        if (i + batchSize < jobs.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    if (blockedCount > 0) {
        log.warning(`${blockedCount} detail pages were blocked by Cloudflare - using snippets instead`);
    }

    return enrichedJobs;
}

/**
 * Build Monster.com search URL from input parameters
 */
function buildSearchUrl(input) {
    if (input.searchUrl && input.searchUrl.trim()) {
        log.info('Using provided search URL directly');
        return input.searchUrl.trim();
    }

    const baseUrl = 'https://www.monster.com/jobs/search';
    const params = new URLSearchParams();

    if (input.searchQuery) {
        params.append('q', input.searchQuery);
    }

    if (input.location) {
        params.append('where', input.location);
    }

    // Monster.com uses page parameter for pagination
    params.append('page', '1');

    // Sort by most recent
    if (input.sortBy === 'date') {
        params.append('so', 'm.h.s'); // Most recent
    } else {
        params.append('so', 'm.h.sh'); // Most relevant (default)
    }

    return `${baseUrl}?${params.toString()}`;
}

/**
 * Extract job data from Monster.com HTML using Cheerio (Fallback method)
 * Updated with comprehensive Monster.com selectors
 */
async function extractJobDataViaHTML(page) {
    log.info('Extracting job data via HTML parsing with Cheerio');

    try {
        const html = await page.content();
        const $ = cheerio.load(html);
        const jobs = [];

        // Monster.com job card selectors - UPDATED for current structure
        const jobCardSelectors = [
            'div[data-test-id="svx-job-card"]',          // Current Monster structure
            'div[data-testid="job-card"]',
            'div.job-card-container',
            'div.job-listing',
            'article.job-card',
            '[data-test-id*="job"]',
            '[class*="JobCard"]',
            'div[id*="job-"]',
            'section[class*="job"]'
        ];

        let jobElements = $([]);
        let selectorUsed = '';

        for (const selector of jobCardSelectors) {
            const elements = $(selector);
            if (elements.length > 0) {
                log.info(`Found ${elements.length} job cards with selector: ${selector}`);
                jobElements = elements;
                selectorUsed = selector;
                break;
            }
        }

        if (jobElements.length === 0) {
            log.warning('No job cards found with any selector. Trying fallback extraction...');
            
            // Fallback: look for links with job-related URLs
            const jobLinks = $('a[href*="/job-openings/"], a[href*="/job/"], a[href*="jobid="]');
            if (jobLinks.length > 0) {
                log.info(`Found ${jobLinks.length} job links via fallback method`);
                
                jobLinks.each((_, el) => {
                    const $link = $(el);
                    const href = $link.attr('href');
                    const title = $link.text().trim();
                    
                    if (title && title.length > 5) {
                        let fullUrl = href;
                        if (href && !href.startsWith('http')) {
                            fullUrl = `https://www.monster.com${href}`;
                        }
                        
                        // Try to find company and location in parent elements
                        const $parent = $link.closest('div, article, section');
                        const company = $parent.find('[class*="company"], [class*="Company"]').first().text().trim();
                        const location = $parent.find('[class*="location"], [class*="Location"]').first().text().trim();
                        
                        jobs.push({
                            title,
                            company: company || '',
                            location: location || '',
                            salary: 'Not specified',
                            jobType: 'Not specified',
                            postedDate: '',
                            descriptionHtml: '',
                            descriptionText: '',
                            url: fullUrl,
                            scrapedAt: new Date().toISOString()
                        });
                    }
                });
                
                log.info(`Extracted ${jobs.length} jobs via fallback link extraction`);
                return jobs;
            }
            
            return [];
        }

        log.info(`Processing ${jobElements.length} job cards with selector: ${selectorUsed}`);

        jobElements.each((_, element) => {
            const job = extractJobFromElement($, $(element));
            if (job) jobs.push(job);
        });

        log.info(`Extracted ${jobs.length} jobs via HTML parsing`);
        return jobs;

    } catch (error) {
        log.warning(`HTML parsing failed: ${error.message}`);
        return [];
    }
}

/**
 * Extract job data from a single Monster.com job card element
 * Updated with comprehensive selector patterns
 */
function extractJobFromElement($, $el) {
    try {
        // Job Title - comprehensive selector list
        const titleSelectors = [
            'h2[data-test-id="svx-job-card-title"] a',   // Current Monster structure
            'h2[data-testid="job-title"] a',
            'a[data-test-id="job-card-title"]',
            'a[data-testid="job-card-title"]',
            'h2 a[data-test-id*="title"]',
            '.job-card-title a',
            '.job-title a',
            'h2.title a',
            'a[href*="/job-openings/"]',
            'a[href*="/job/"]',
            'h2 a',
            'h3 a'
        ];

        let title = '';
        let url = '';

        for (const selector of titleSelectors) {
            const titleEl = $el.find(selector).first();
            if (titleEl.length) {
                title = titleEl.text().trim();
                url = titleEl.attr('href') || '';
                if (url && !url.startsWith('http')) {
                    url = `https://www.monster.com${url}`;
                }
                if (title) {
                    log.debug(`Title found with selector: ${selector}`);
                    break;
                }
            }
        }

        // Company name - comprehensive selectors
        const companySelectors = [
            'div[data-test-id="svx-job-card-company"]',  // Current Monster structure
            '[data-testid="job-card-company"]',
            '[data-test-id="job-card-company"]',
            '[data-testid="company-name"]',
            'div.company-name',
            'span.company-name',
            'div[class*="company"]',
            'span[class*="company"]',
            'div[class*="Company"]',
            '[data-company]'
        ];

        let company = '';
        for (const selector of companySelectors) {
            const companyEl = $el.find(selector).first();
            if (companyEl.length && companyEl.text().trim()) {
                company = companyEl.text().trim();
                log.debug(`Company found with selector: ${selector}`);
                break;
            }
        }

        // Location - comprehensive selectors
        const locationSelectors = [
            'div[data-test-id="svx-job-card-location"]',  // Current Monster structure
            '[data-testid="job-card-location"]',
            '[data-test-id="job-card-location"]',
            '[data-testid="location"]',
            'div.location',
            'span.location',
            'div[class*="location"]',
            'span[class*="location"]',
            'div[class*="Location"]',
            '[data-location]'
        ];

        let location = '';
        for (const selector of locationSelectors) {
            const locEl = $el.find(selector).first();
            if (locEl.length && locEl.text().trim()) {
                location = locEl.text().trim();
                log.debug(`Location found with selector: ${selector}`);
                break;
            }
        }

        // Salary - comprehensive selectors
        const salarySelectors = [
            'div[data-test-id="svx-job-card-salary"]',
            '[data-testid="job-card-salary"]',
            '[data-test-id="salary"]',
            '[data-testid="salary"]',
            'div.salary',
            'span.salary',
            'div[class*="salary"]',
            'span[class*="Salary"]',
            'div[class*="compensation"]'
        ];

        let salary = 'Not specified';
        for (const selector of salarySelectors) {
            const salEl = $el.find(selector).first();
            if (salEl.length && salEl.text().trim()) {
                salary = salEl.text().trim();
                break;
            }
        }

        // Job snippet/description
        const snippetSelectors = [
            'div[data-test-id="svx-job-card-snippet"]',
            '[data-testid="job-card-description"]',
            '[data-testid="snippet"]',
            '.job-card-description',
            '.job-description',
            '.description',
            'div[class*="Description"]',
            'div[class*="snippet"]',
            'p'
        ];

        let snippet = '';
        for (const selector of snippetSelectors) {
            const descEl = $el.find(selector).first();
            if (descEl.length && descEl.text().trim().length > 20) {
                snippet = descEl.text().trim();
                break;
            }
        }

        // Posted date
        const dateSelectors = [
            'div[data-test-id="svx-job-card-posted-date"]',
            '[data-testid="job-card-date"]',
            '[data-testid="posted-date"]',
            '.posted-date',
            'time',
            'span[class*="date"]',
            'span[class*="time"]',
            '[datetime]'
        ];

        let postedDate = '';
        for (const selector of dateSelectors) {
            const dateEl = $el.find(selector).first();
            if (dateEl.length && dateEl.text().trim()) {
                postedDate = dateEl.text().trim();
                break;
            }
        }

        // Only return job if we have at least title OR url
        if (title || url) {
            log.debug(`Successfully extracted job: ${title || 'No title'}`);
            return {
                title: title || 'Unknown Title',
                company,
                location,
                salary,
                jobType: 'Not specified',
                postedDate,
                descriptionHtml: snippet,
                descriptionText: snippet,
                url,
                scrapedAt: new Date().toISOString()
            };
        }

        log.debug('Skipped job card - no title or URL found');
        return null;
    } catch (err) {
        log.debug(`Error extracting individual job: ${err.message}`);
        return null;
    }
}

/**
 * Debug: Save page HTML and structure analysis when no jobs found
 */
async function saveDebugInfo(page) {
    try {
        const html = await page.content();
        const $ = cheerio.load(html);

        // Analyze page structure
        const structureAnalysis = {
            title: $('title').text(),
            url: page.url(),
            hasCloudflare: html.includes('Just a moment') || html.includes('cf-browser'),
            
            // Count various elements
            elementCounts: {
                articles: $('article').length,
                divsWithJob: $('[class*="job" i]').length,
                divsWithCard: $('[class*="card" i]').length,
                dataTestIds: $('[data-test-id]').length,
                dataTestIdJob: $('[data-test-id*="job" i]').length,
                links: $('a').length,
                jobLinks: $('a[href*="/job"]').length,
            },
            
            // Sample data-test-id attributes
            sampleDataTestIds: [],
            
            // Sample class names
            sampleClasses: [],
            
            // Check for common Monster.com elements
            monsterElements: {
                hasNextData: html.includes('__NEXT_DATA__'),
                hasInitialState: html.includes('__INITIAL_STATE__'),
                hasJobResults: html.includes('jobResults'),
                hasSearchResults: html.includes('searchResults'),
            }
        };

        // Collect sample data-test-id attributes
        $('[data-test-id]').slice(0, 20).each((_, el) => {
            const testId = $(el).attr('data-test-id');
            if (testId && !structureAnalysis.sampleDataTestIds.includes(testId)) {
                structureAnalysis.sampleDataTestIds.push(testId);
            }
        });

        // Collect sample class names from divs
        $('div[class]').slice(0, 30).each((_, el) => {
            const className = $(el).attr('class');
            if (className && className.length < 100) {
                structureAnalysis.sampleClasses.push(className);
            }
        });

        log.warning('═══════════════════════════════════════════════');
        log.warning('DEBUG: Page Structure Analysis');
        log.warning('═══════════════════════════════════════════════');
        log.warning(`Title: ${structureAnalysis.title}`);
        log.warning(`URL: ${structureAnalysis.url}`);
        log.warning(`Has Cloudflare: ${structureAnalysis.hasCloudflare}`);
        log.warning('');
        log.warning('Element Counts:');
        Object.entries(structureAnalysis.elementCounts).forEach(([key, value]) => {
            log.warning(`  ${key}: ${value}`);
        });
        log.warning('');
        log.warning('Monster.com Elements:');
        Object.entries(structureAnalysis.monsterElements).forEach(([key, value]) => {
            log.warning(`  ${key}: ${value}`);
        });
        log.warning('');
        log.warning('Sample data-test-id attributes:');
        structureAnalysis.sampleDataTestIds.slice(0, 10).forEach(id => {
            log.warning(`  - ${id}`);
        });
        log.warning('');
        log.warning('Sample class names:');
        structureAnalysis.sampleClasses.slice(0, 10).forEach(className => {
            log.warning(`  - ${className}`);
        });
        log.warning('═══════════════════════════════════════════════');

        // Save full HTML and analysis
        await Actor.setValue('DEBUG_PAGE_HTML', html, { contentType: 'text/html' });
        await Actor.setValue('DEBUG_STRUCTURE_ANALYSIS', structureAnalysis);
        
        log.info('✓ Saved debug HTML and structure analysis to key-value store');
        log.info('  - DEBUG_PAGE_HTML: Full page HTML');
        log.info('  - DEBUG_STRUCTURE_ANALYSIS: Structure analysis JSON');

    } catch (error) {
        log.warning(`Failed to save debug info: ${error.message}`);
    }
}

/**
 * Main Actor execution
 */
try {
    const input = await Actor.getInput() || {};

    log.info('Starting Monster Jobs Scraper', {
        searchUrl: input.searchUrl,
        searchQuery: input.searchQuery,
        location: input.location,
        maxJobs: input.maxJobs
    });

    // Validate input
    if (!input.searchUrl?.trim()) {
        if (!input.searchQuery?.trim() || !input.location?.trim()) {
            throw new Error('Invalid input: Either provide a "searchUrl" OR both "searchQuery" and "location" are required');
        }
    }

    const maxJobs = input.maxJobs ?? 20;
    if (maxJobs < 0 || maxJobs > 10000) {
        throw new Error('maxJobs must be between 0 and 10000');
    }

    const searchUrl = buildSearchUrl(input);
    log.info(`Search URL: ${searchUrl}`);

    const proxyConfiguration = await Actor.createProxyConfiguration(
        input.proxyConfiguration || { useApifyProxy: true }
    );

    let totalJobsScraped = 0;
    let pagesProcessed = 0;
    let extractionMethod = 'None';
    const startTime = Date.now();

    const seenJobUrls = new Set();

    const proxyUrl = await proxyConfiguration.newUrl();

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestsPerCrawl: 20,
        maxConcurrency: 3,
        navigationTimeoutSecs: 30,
        requestHandlerTimeoutSecs: 120,
        launchContext: {
            launcher: firefox,
            launchOptions: await camoufoxLaunchOptions({
                headless: true,
                proxy: proxyUrl,
                geoip: true,
                os: 'windows',
                locale: 'en-US',
                screen: {
                    minWidth: 1024,
                    maxWidth: 1920,
                    minHeight: 768,
                    maxHeight: 1080,
                },
            }),
        },

        async requestHandler({ page, request }) {
            pagesProcessed++;
            log.info(`Processing page ${pagesProcessed}: ${request.url}`);

            try {
                // Set up API interceptor BEFORE navigation
                const capturedApiJobs = await setupAPIInterceptor(page);

                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1',
                });

                await page.goto(request.url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });

                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });

                // Check for Cloudflare challenge
                let cloudflareDetected = false;
                let retryCount = 0;
                const maxRetries = 3;

                while (retryCount < maxRetries) {
                    const title = await page.title();
                    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');

                    if (title.includes('Just a moment') ||
                        title.includes('Cloudflare') ||
                        bodyText.includes('unusual traffic') ||
                        bodyText.includes('Checking your browser')) {

                        cloudflareDetected = true;
                        log.warning(`Cloudflare challenge detected (attempt ${retryCount + 1}/${maxRetries})`);

                        await page.waitForTimeout(3000);

                        try {
                            const turnstileFrame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]');
                            const checkbox = turnstileFrame.locator('input[type="checkbox"], .cf-turnstile-wrapper');

                            if (await checkbox.count() > 0) {
                                log.info('Found Turnstile checkbox, attempting click...');
                                await checkbox.first().click({ timeout: 5000 });
                                await page.waitForTimeout(3000);
                            }
                        } catch (clickErr) {
                            log.debug('No clickable Turnstile element found');
                        }

                        await page.waitForTimeout(5000);
                        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

                        retryCount++;
                    } else {
                        if (cloudflareDetected) {
                            log.info('Cloudflare challenge bypassed successfully!');
                        }
                        break;
                    }
                }

                if (retryCount >= maxRetries) {
                    log.error('Failed to bypass Cloudflare after maximum retries');
                    await saveDebugInfo(page);
                    return;
                }

                // Wait for dynamic content to load
                await page.waitForTimeout(2000);

                let jobs = [];

                // STRATEGY 1: Check if API interceptor captured jobs (FASTEST)
                if (capturedApiJobs.length > 0) {
                    log.info(`✓ Using intercepted API data: ${capturedApiJobs.length} jobs`);
                    
                    jobs = capturedApiJobs.map(job => {
                        const jobUrl = job.jobUrl || job.url || job.applyUrl || 
                                      job.jobViewUrl || job.detailUrl ||
                                      (job.jobId ? `https://www.monster.com/job-openings/${job.jobId}` : '');
                        
                        let location = job.location || job.jobLocation || job.city || '';
                        if (typeof location === 'object') {
                            location = [location.city, location.state, location.country].filter(Boolean).join(', ');
                        }

                        return {
                            title: job.title || job.jobTitle || job.name || '',
                            company: job.company || job.companyName || job.hiringCompany || job.companyDisplayName || '',
                            location,
                            salary: job.salary || job.compensation || job.estimatedSalary || 'Not specified',
                            jobType: job.jobType || job.employmentType || job.type || 'Not specified',
                            postedDate: job.postedDate || job.datePosted || job.listedDate || job.postedAt || '',
                            descriptionHtml: job.description || job.jobDescription || job.snippet || '',
                            descriptionText: stripHtml(job.description || job.jobDescription || job.snippet || ''),
                            url: jobUrl,
                            scrapedAt: new Date().toISOString()
                        };
                    });
                    
                    extractionMethod = 'API Interceptor (Network)';
                }

                // STRATEGY 2: Try Monster embedded API/Next.js data
                if (jobs.length === 0) {
                    jobs = await extractJobsViaMonsterAPI(page);
                    if (jobs.length > 0) {
                        extractionMethod = 'Monster Embedded API (Next.js)';
                        log.info(`✓ Embedded API extraction successful: ${jobs.length} jobs`);
                    }
                }

                // STRATEGY 3: Try JSON-LD structured data
                if (jobs.length === 0) {
                    jobs = await extractJobsViaJsonLD(page);
                    if (jobs.length > 0) {
                        extractionMethod = 'JSON-LD Schema';
                        log.info(`✓ JSON-LD extraction successful: ${jobs.length} jobs`);
                    }
                }

                // STRATEGY 4: Fall back to HTML parsing with Cheerio
                if (jobs.length === 0) {
                    jobs = await extractJobDataViaHTML(page);
                    if (jobs.length > 0) {
                        extractionMethod = 'HTML Parsing (Cheerio)';
                        log.info(`✓ HTML parsing successful: ${jobs.length} jobs`);
                    }
                }

                // If still no jobs, save debug info and log page structure
                if (jobs.length === 0) {
                    log.error('❌ No jobs found with ANY extraction method');
                    log.warning('Saving debug info for analysis...');
                    await saveDebugInfo(page);
                    
                    // Log page title and URL for debugging
                    const pageTitle = await page.title();
                    const pageUrl = page.url();
                    log.warning(`Page Title: ${pageTitle}`);
                    log.warning(`Page URL: ${pageUrl}`);
                    
                    return; // Skip this page
                }

                if (jobs.length > 0) {
                    log.info(`✓ Successfully extracted ${jobs.length} jobs using: ${extractionMethod}`);
                    
                    let jobsToSave = maxJobs > 0
                        ? jobs.slice(0, Math.max(0, maxJobs - totalJobsScraped))
                        : jobs;

                    const uniqueJobs = jobsToSave.filter(job => {
                        if (!job.url) return true;

                        if (seenJobUrls.has(job.url)) {
                            log.debug(`Skipping duplicate job: ${job.title} (${job.url})`);
                            return false;
                        }

                        seenJobUrls.add(job.url);
                        return true;
                    });

                    if (uniqueJobs.length < jobsToSave.length) {
                        log.info(`Removed ${jobsToSave.length - uniqueJobs.length} duplicate jobs`);
                    }

                    jobsToSave = uniqueJobs;

                    if (jobsToSave.length > 0) {
                        log.info('Enriching jobs with full descriptions from detail pages...');
                        jobsToSave = await enrichJobsWithFullDescriptions(jobsToSave, page);
                    }

                    if (jobsToSave.length > 0) {
                        await Actor.pushData(jobsToSave);
                        totalJobsScraped += jobsToSave.length;
                        log.info(`✓ Saved ${jobsToSave.length} jobs. Total: ${totalJobsScraped}`);
                    }

                    if (maxJobs > 0 && totalJobsScraped >= maxJobs) {
                        log.info(`✓ Reached maximum jobs limit: ${maxJobs}`);
                        return;
                    }

                    // Monster.com pagination - check for next page
                    const currentUrl = new URL(request.url);
                    const currentPage = parseInt(currentUrl.searchParams.get('page') || '1');

                    // Check if next page button exists and is not disabled
                    const hasNextPage = await page.evaluate(() => {
                        // Look for pagination buttons
                        const nextButton = document.querySelector('button[aria-label*="next" i]') ||
                            document.querySelector('a[aria-label*="next" i]') ||
                            document.querySelector('button:has-text("Next")') ||
                            document.querySelector('a:has-text("Next")') ||
                            document.querySelector('[data-test-id="pagination-next"]') ||
                            document.querySelector('.pagination button:last-child');

                        if (nextButton) {
                            const isDisabled = nextButton.hasAttribute('disabled') ||
                                nextButton.classList.contains('disabled') ||
                                nextButton.getAttribute('aria-disabled') === 'true';
                            return !isDisabled;
                        }

                        return false;
                    });

                    if (hasNextPage && totalJobsScraped < maxJobs) {
                        const nextPage = currentPage + 1;
                        currentUrl.searchParams.set('page', nextPage.toString());
                        const nextPageUrl = currentUrl.toString();

                        log.info(`Found next page: ${nextPageUrl} (page ${nextPage})`);

                        await crawler.addRequests([{
                            url: nextPageUrl,
                            uniqueKey: nextPageUrl
                        }]);
                    } else if (!hasNextPage) {
                        log.info('No next page button found - reached last page');
                    }
                }

            } catch (error) {
                log.error(`Error processing page: ${error.message}`, {
                    url: request.url,
                    stack: error.stack
                });
            }
        },

        async failedRequestHandler({ request }, error) {
            log.error(`Request failed: ${request.url} - ${error.message}`);
        }
    });

    log.info('Starting crawler with Camoufox for Cloudflare bypass...');
    await crawler.run([searchUrl]);

    const endTime = Date.now();
    const duration = Math.round((endTime - startTime) / 1000);

    const statistics = {
        totalJobsScraped,
        pagesProcessed,
        extractionMethod,
        duration: `${duration} seconds`,
        timestamp: new Date().toISOString()
    };

    await Actor.setValue('statistics', statistics);

    log.info('✓ Scraping completed successfully!', statistics);

    if (totalJobsScraped > 0) {
        log.info(`Successfully scraped ${totalJobsScraped} jobs in ${duration} seconds`);
    } else {
        log.warning('No jobs were scraped. Please check your search parameters.');
    }

} catch (error) {
    log.exception(error, 'Actor failed with error');
    throw error;
}

await Actor.exit();
