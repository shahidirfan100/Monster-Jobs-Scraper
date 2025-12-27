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
 * Normalize Monster job object variants into our unified format
 */
function normalizeMonsterJob(job) {
    const jobUrl = job.jobUrl || job.url || job.applyUrl ||
        job.jobViewUrl || job.detailUrl ||
        (job.jobId ? `https://www.monster.com/job-openings/${job.jobId}` : '');

    let location = job.location || job.jobLocation || job.city || job.state || '';
    if (typeof location === 'object' && location !== null) {
        location = [location.city, location.state || location.stateProvince, location.country].filter(Boolean).join(', ');
    }

    const description = job.description || job.jobDescription || job.snippet || job.text || '';

    return {
        title: job.title || job.jobTitle || job.name || '',
        company: job.company || job.companyName || job.hiringCompany || job.companyDisplayName || '',
        location,
        salary: job.salary || job.compensation || job.estimatedSalary || job.pay || 'Not specified',
        jobType: job.jobType || job.employmentType || job.type || 'Not specified',
        postedDate: job.postedDate || job.datePosted || job.listedDate || job.postedAt || '',
        descriptionHtml: description,
        descriptionText: stripHtml(description),
        url: jobUrl,
        scrapedAt: new Date().toISOString()
    };
}

/**
 * Extract job arrays from common Monster/Next.js data structures
 */
function extractJobsFromDataObject(data) {
    const jobCollections = [
        data?.props?.pageProps?.searchResults?.jobs,
        data?.props?.pageProps?.searchResults?.docs,
        data?.props?.pageProps?.searchResults?.results,
        data?.props?.pageProps?.jobs,
        data?.props?.pageProps?.initialJobs,
        data?.props?.pageProps?.serp?.jobs,
        data?.props?.pageProps?.serpResults?.jobs,
        data?.props?.pageProps?.results?.jobs,
        data?.jobResults,
        data?.searchResults?.docs,
        data?.searchResults?.results,
        data?.data?.jobs,
        data?.docs,
        data?.results,
    ];

    let jobArray = jobCollections.find(arr => Array.isArray(arr) && arr.length > 0);
    if (!jobArray && Array.isArray(data)) jobArray = data;
    if (!jobArray && data?.itemListElement && Array.isArray(data.itemListElement)) {
        jobArray = data.itemListElement.map(item => item.item || item).filter(Boolean);
    }

    // Deep search: find any array of objects that look like jobs (have jobTitle/title + jobId/jobUrl)
    if (!jobArray) {
        const visited = new WeakSet();
        const candidates = [];

        const walk = (node, depth = 0) => {
            if (!node || typeof node !== 'object' || depth > 6) return;
            if (visited.has(node)) return;
            visited.add(node);

            if (Array.isArray(node) && node.length > 0 && typeof node[0] === 'object') {
                const hasJobShape = node.some(item =>
                    item &&
                    (item.jobTitle || item.title || item.name) &&
                    (item.jobId || item.jobid || item.jobUrl || item.jobViewUrl || item.url || item.applyUrl)
                );
                if (hasJobShape) {
                    candidates.push(node);
                }
            }

            for (const value of Object.values(node)) {
                walk(value, depth + 1);
            }
        };

        walk(data);
        if (candidates.length > 0) jobArray = candidates[0];
    }

    if (!jobArray || !Array.isArray(jobArray)) return [];
    return jobArray.map(normalizeMonsterJob);
}

/**
 * Extract jobs from __NEXT_DATA__ or embedded JSON in static HTML
 */
function extractJobsFromNextDataHtml(html) {
    const $ = cheerio.load(html);
    const nextScript = $('#__NEXT_DATA__').html() || $('script[id="__NEXT_DATA__"]').html();
    if (!nextScript) {
        // Look for inline initial state blobs
        const inlineScripts = $('script:not([src])').map((_, el) => $(el).text()).get();
        for (const scriptContent of inlineScripts) {
            const matches = scriptContent.match(/__INITIAL_STATE__\s*=\s*(\{.*?\});/s) ||
                scriptContent.match(/window\\.APP_DATA\\s*=\\s*(\\{.*?\\});/s);
            if (matches && matches[1]) {
                try {
                    const data = JSON.parse(matches[1]);
                    const jobs = extractJobsFromDataObject(data);
                    if (jobs.length) return { jobs, source: '__INITIAL_STATE__' };
                } catch (err) {
                    log.debug(`Failed to parse inline state JSON: ${err.message}`);
                }
            }
        }
        return { jobs: [], source: null };
    }

    try {
        const data = JSON.parse(nextScript);
        const jobs = extractJobsFromDataObject(data);
        return { jobs, source: '__NEXT_DATA__' };
    } catch (err) {
        log.debug(`Failed to parse __NEXT_DATA__: ${err.message}`);
        return { jobs: [], source: null };
    }
}

/**
 * Extract jobs from JSON-LD inside static HTML
 */
function extractJobsFromJsonLdHtml(html) {
    const $ = cheerio.load(html);
    const scripts = $('script[type="application/ld+json"]')
        .map((_, el) => $(el).text())
        .get();

    const jobs = [];

    for (const content of scripts) {
        try {
            const data = JSON.parse(content);
            const parsed = extractJobsFromDataObject(data);
            if (parsed.length) {
                jobs.push(...parsed);
                continue;
            }

            if (Array.isArray(data)) {
                for (const item of data) {
                    if (item['@type'] === 'JobPosting') jobs.push(parseJobPosting(item));
                }
            } else if (data['@type'] === 'JobPosting') {
                jobs.push(parseJobPosting(data));
            } else if (data['@graph']) {
                for (const item of data['@graph']) {
                    if (item['@type'] === 'JobPosting') jobs.push(parseJobPosting(item));
                }
            }
        } catch (err) {
            log.debug(`Failed to parse JSON-LD in HTML: ${err.message}`);
        }
    }

    return jobs;
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
                    jobs.push(normalizeMonsterJob(job));
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
async function fetchFullDescription(jobUrl, options = {}) {
    const {
        cookies = '',
        userAgent = '',
        proxyUrl,
    } = options;

    try {
        const response = await gotScraping({
            url: jobUrl,
            proxyUrl,
            useHeaderGenerator: true,
            headerGeneratorOptions: {
                browsers: ['firefox', 'chrome'],
                devices: ['desktop'],
                operatingSystems: ['windows', 'macos'],
                locales: ['en-US', 'en'],
            },
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                ...(cookies ? { Cookie: cookies } : {}),
                ...(userAgent ? { 'User-Agent': userAgent } : {}),
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
async function enrichJobsWithFullDescriptions(jobs, options = {}) {
    const {
        page = null,
        proxyConfiguration = null,
        maxConcurrency = 5,
    } = options;

    if (jobs.length === 0) return jobs;

    log.info(`Fetching full descriptions for ${jobs.length} jobs...`);

    let cookieString = '';
    let userAgent = '';
    let proxyUrl = null;

    if (page) {
        const cookies = await page.context().cookies();
        cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        userAgent = await page.evaluate(() => navigator.userAgent);
        log.debug(`Using ${cookies.length} cookies from Camoufox session for detail pages`);
    }

    if (!proxyUrl && proxyConfiguration) {
        proxyUrl = await proxyConfiguration.newUrl();
    }

    const enrichedJobs = [];
    const batchSize = maxConcurrency;
    let blockedCount = 0;

    for (let i = 0; i < jobs.length; i += batchSize) {
        const batch = jobs.slice(i, i + batchSize);

        const batchPromises = batch.map(async (job) => {
            if (!job.url) return job;

            const fullDesc = await fetchFullDescription(job.url, {
                cookies: cookieString,
                userAgent,
                proxyUrl,
            });

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
    log.info('Extracting job data via HTML parsing with Cheerio (Playwright)');

    try {
        const html = await page.content();
        const $ = cheerio.load(html);
        return extractJobsFromCheerioDocument($, 'Playwright HTML parsing');
    } catch (error) {
        log.warning(`HTML parsing failed: ${error.message}`);
        return [];
    }
}

/**
 * Extract job data from static HTML (HTTP flow)
 */
function extractJobDataFromHtmlString(html) {
    const $ = cheerio.load(html);
    return extractJobsFromCheerioDocument($, 'HTTP HTML parsing');
}

/**
 * Shared Cheerio-based job card extraction
 */
function extractJobsFromCheerioDocument($, logPrefix = 'HTML parsing') {
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
            log.info(`[${logPrefix}] Found ${elements.length} job cards with selector: ${selector}`);
            jobElements = elements;
            selectorUsed = selector;
            break;
        }
    }

    if (jobElements.length === 0) {
        log.warning(`[${logPrefix}] No job cards found with any selector. Trying fallback extraction...`);

        // Fallback: look for links with job-related URLs
        const jobLinks = $('a[href*="/job-openings/"], a[href*="/job/"], a[href*="jobid="]');
        if (jobLinks.length > 0) {
            log.info(`[${logPrefix}] Found ${jobLinks.length} job links via fallback method`);

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

            log.info(`[${logPrefix}] Extracted ${jobs.length} jobs via fallback link extraction`);
            return jobs;
        }

        return [];
    }

    log.info(`[${logPrefix}] Processing ${jobElements.length} job cards with selector: ${selectorUsed}`);

    jobElements.each((_, element) => {
        const job = extractJobFromElement($, $(element));
        if (job) jobs.push(job);
    });

    log.info(`[${logPrefix}] Extracted ${jobs.length} jobs via HTML parsing`);
    return jobs;
}

function detectCloudflareInHtml(html) {
    if (!html) return false;
    return /Cloudflare|Just a moment|unusual traffic|cf-browser/i.test(html);
}

/**
 * Fetch search page HTML via fast HTTP request
 */
async function fetchSearchPageHtml(url, proxyConfiguration) {
    try {
        const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
        const response = await gotScraping({
            url,
            proxyUrl,
            useHeaderGenerator: true,
            headerGeneratorOptions: {
                browsers: ['firefox', 'chrome'],
                devices: ['desktop'],
                operatingSystems: ['windows', 'macos'],
                locales: ['en-US', 'en'],
            },
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Upgrade-Insecure-Requests': '1',
            },
            timeout: { request: 15000 },
            retry: { limit: 2 },
        });

        return { html: response.body, statusCode: response.statusCode };
    } catch (error) {
        log.warning(`HTTP fetch failed for ${url}: ${error.message}`);
        return { html: '', statusCode: 0, error };
    }
}

/**
 * Attempt multiple extraction strategies on static HTML
 */
function extractJobsFromHtmlPage(html) {
    const nextData = extractJobsFromNextDataHtml(html);
    if (nextData.jobs.length) {
        return { jobs: nextData.jobs, methodUsed: `HTTP ${nextData.source || 'Embedded JSON'}` };
    }

    const jsonLdJobs = extractJobsFromJsonLdHtml(html);
    if (jsonLdJobs.length) {
        return { jobs: jsonLdJobs, methodUsed: 'HTTP JSON-LD' };
    }

    const htmlJobs = extractJobDataFromHtmlString(html);
    if (htmlJobs.length) {
        return { jobs: htmlJobs, methodUsed: 'HTTP HTML parsing' };
    }

    return { jobs: [], methodUsed: null };
}

/**
 * HTTP-first extraction loop (JSON/Next.js/HTML) with pagination
 */
async function extractJobsHttpFirst(searchUrl, proxyConfiguration, options = {}) {
    const { maxJobs = 20, maxPages = 3 } = options;
    const jobs = [];
    let pagesProcessed = 0;
    let method = '';

    const baseUrl = new URL(searchUrl);
    const startPage = parseInt(baseUrl.searchParams.get('page') || '1', 10);

    for (let page = startPage; (maxPages === 0 || pagesProcessed < maxPages) && (maxJobs === 0 || jobs.length < maxJobs); page++) {
        baseUrl.searchParams.set('page', page.toString());
        const currentUrl = baseUrl.toString();

        log.info(`HTTP fetch for page ${page}: ${currentUrl}`);
        const { html, statusCode } = await fetchSearchPageHtml(currentUrl, proxyConfiguration);
        pagesProcessed++;

        if (!html) {
            log.warning(`Empty response for page ${page} (status ${statusCode || 'unknown'})`);
            break;
        }

        if (detectCloudflareInHtml(html)) {
            log.warning(`Cloudflare challenge detected in HTTP response for ${currentUrl} - switching to browser fallback`);
            return { jobs: [], pagesProcessed, method: 'HTTP blocked' };
        }

        const { jobs: pageJobs, methodUsed } = extractJobsFromHtmlPage(html);
        if (!method && methodUsed) method = methodUsed;

        if (!pageJobs.length) {
            log.info(`No jobs found on HTTP page ${page}, stopping HTTP flow`);
            break;
        }

        for (const job of pageJobs) {
            if (maxJobs > 0 && jobs.length >= maxJobs) break;
            jobs.push(job);
        }

        if (maxJobs > 0 && jobs.length >= maxJobs) break;
    }

    return { jobs, pagesProcessed, method: method || 'HTTP parsing' };
}

/**
 * Collect jobs from the AJAX-loaded sidebar list (Playwright only)
 */
async function collectSidebarAjaxJobs(page, maxJobs) {
    const jobs = [];
    try {
        const headingSelector = 'h3.indexmodern__JobCardHeading-sc-9vl52l-20';
        // Wait briefly for sidebar items to render
        await page.waitForSelector(headingSelector, { timeout: 8000 });

        // Try to click "Load" / "More" buttons until we reach maxJobs or no more buttons
        const loadButtons = [
            'button:has-text("Load more")',
            'button:has-text("Load jobs")',
            'button:has-text("See more")',
            'button[aria-label*="load" i]',
        ];

        const clickMoreIfAvailable = async () => {
            for (const sel of loadButtons) {
                const btn = page.locator(sel);
                if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
                    await btn.click({ timeout: 2000 }).catch(() => {});
                    await page.waitForTimeout(1200);
                    return true;
                }
            }
            return false;
        };

        // Loop loading more until we hit maxJobs or no more buttons
        while (jobs.length < maxJobs) {
            const sidebarJobs = await page.$$eval(headingSelector, (nodes) => {
                return nodes.map((node) => {
                    const title = node.textContent?.trim() || '';
                    // Find nearest anchor ancestor or sibling
                    let linkEl = node.closest('a');
                    if (!linkEl) {
                        const parentLink = node.parentElement?.querySelector('a');
                        if (parentLink) linkEl = parentLink;
                    }
                    const href = linkEl?.getAttribute('href') || '';
                    return { title, href };
                }).filter(j => j.title && j.href);
            });

            for (const item of sidebarJobs) {
                if (jobs.length >= maxJobs) break;
                const url = item.href.startsWith('http') ? item.href : `https://www.monster.com${item.href}`;
                jobs.push({
                    title: item.title,
                    company: '',
                    location: '',
                    salary: 'Not specified',
                    jobType: 'Not specified',
                    postedDate: '',
                    descriptionHtml: '',
                    descriptionText: '',
                    url,
                    scrapedAt: new Date().toISOString(),
                });
            }

            if (jobs.length >= maxJobs) break;
            const clicked = await clickMoreIfAvailable();
            if (!clicked) break;
        }
    } catch (err) {
        log.debug(`Sidebar AJAX collection failed: ${err.message}`);
    }
    return jobs;
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
            'h2[data-test-id="svx-job-card-title"]',
            'h2[data-testid="job-title"] a',
            '[data-testid="job-title"]',
            'a[data-test-id="job-card-title"]',
            'a[data-testid="job-card-title"]',
            'h2 a[data-test-id*="title"]',
            '.job-card-title a',
            '.job-card-title',
            '.job-title a',
            '.job-title',
            'h2.title a',
            'h2.title',
            'a[href*="/job-openings/"]',
            'a[href*="/job/"]',
            'h2 a',
            'h3 a',
            '[data-job-title]',
            '[aria-label*="job" i]'
        ];

        let title = '';
        let url = '';

        for (const selector of titleSelectors) {
            const titleEl = $el.find(selector).first();
            if (titleEl.length) {
                title = titleEl.text().trim() || titleEl.attr('data-job-title') || titleEl.attr('aria-label') || '';
                url = titleEl.attr('href') || titleEl.attr('data-job-url') || '';
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
            '[data-company]',
            '[data-job-company]'
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
            '[data-location]',
            '[data-job-location]'
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
            '[data-job-snippet]',
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
            'time[datetime]',
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

        // Fallback: use data attributes if URL missing
        if (!url) {
            const dataUrl = $el.attr('data-job-url') || $el.attr('data-url');
            const jobId = $el.attr('data-jobid') || $el.attr('data-job-id');
            if (dataUrl) {
                url = dataUrl.startsWith('http') ? dataUrl : `https://www.monster.com${dataUrl}`;
            } else if (jobId) {
                url = `https://www.monster.com/job-openings/${jobId}`;
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

        log.warning('================ DEBUG: Page Structure Analysis ================');
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
        log.warning('==============================================================');

        // Save full HTML and analysis
        await Actor.setValue('DEBUG_PAGE_HTML', html, { contentType: 'text/html' });
        await Actor.setValue('DEBUG_STRUCTURE_ANALYSIS', structureAnalysis);
        
        log.info('Saved debug HTML and structure analysis to key-value store');
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
    if (!input.searchUrl?.trim() && !input.searchQuery?.trim()) {
        throw new Error('Invalid input: Provide either a "searchUrl" or at least a "searchQuery"');
    }

    const maxJobs = input.maxJobs ?? 20;
    if (maxJobs < 0 || maxJobs > 10000) {
        throw new Error('maxJobs must be between 0 and 10000');
    }

    const maxPages = input.maxPages ?? 3;
    if (maxPages < 0 || maxPages > 30) {
        throw new Error('maxPages must be between 0 and 30 (0 = unlimited)');
    }

    const httpOnly = input.httpOnly ?? false;

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

    // HTTP-first fast path (Next.js/JSON/HTML)
    const httpResult = await extractJobsHttpFirst(searchUrl, proxyConfiguration, {
        maxJobs,
        maxPages,
    });

    pagesProcessed += httpResult.pagesProcessed;

    if (httpResult.jobs.length > 0) {
        log.info(`HTTP extraction succeeded with ${httpResult.jobs.length} jobs via ${httpResult.method}`);
        extractionMethod = httpResult.method;

        let jobsToSave = maxJobs > 0
            ? httpResult.jobs.slice(0, Math.max(0, maxJobs - totalJobsScraped))
            : httpResult.jobs;

        const uniqueJobs = jobsToSave.filter(job => {
            const key = job.url || `${job.title}-${job.company}-${job.location}`;
            if (seenJobUrls.has(key)) return false;
            seenJobUrls.add(key);
            return true;
        });

        if (uniqueJobs.length < jobsToSave.length) {
            log.info(`Removed ${jobsToSave.length - uniqueJobs.length} duplicate jobs from HTTP flow`);
        }

        if (uniqueJobs.length > 0) {
            const enriched = await enrichJobsWithFullDescriptions(uniqueJobs, { proxyConfiguration });
            await Actor.pushData(enriched);
            totalJobsScraped += enriched.length;
            log.info(`Saved ${enriched.length} jobs from HTTP flow`);
        }
    } else {
        log.info('HTTP extraction returned no jobs, will try browser fallback unless disabled.');
    }

    const shouldUseBrowser = !httpOnly && totalJobsScraped === 0;

    if (httpOnly) {
        log.info('HTTP-only mode enabled; skipping browser fallback.');
    } else if (!shouldUseBrowser) {
        log.info('Skipping browser fallback because HTTP extraction succeeded.');
    }

    if (shouldUseBrowser) {
        const proxyUrl = await proxyConfiguration.newUrl();

        const crawler = new PlaywrightCrawler({
            proxyConfiguration,
            maxRequestsPerCrawl: maxPages > 0 ? maxPages : 20,
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

                // STRATEGY 0: AJAX sidebar list using provided selector
                const sidebarJobs = await collectSidebarAjaxJobs(
                    page,
                    Math.max(1, maxJobs > 0 ? maxJobs - totalJobsScraped : 50)
                );
                if (sidebarJobs.length > 0) {
                    log.info(`Sidebar AJAX extraction found ${sidebarJobs.length} jobs, enriching details...`);
                    const enrichedSidebar = await enrichJobsWithFullDescriptions(sidebarJobs, { page, proxyConfiguration });
                    jobs.push(...enrichedSidebar);
                    extractionMethod = 'Sidebar AJAX + Detail';
                }

                // STRATEGY 1: Check if API interceptor captured jobs (FASTEST)
                if (capturedApiJobs.length > 0) {
                    log.info(`Using intercepted API data: ${capturedApiJobs.length} jobs`);

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
                        log.info(`Embedded API extraction successful: ${jobs.length} jobs`);
                    }
                }

                // STRATEGY 3: Try JSON-LD structured data
                if (jobs.length === 0) {
                    jobs = await extractJobsViaJsonLD(page);
                    if (jobs.length > 0) {
                        extractionMethod = 'JSON-LD Schema';
                        log.info(`JSON-LD extraction successful: ${jobs.length} jobs`);
                    }
                }

                // STRATEGY 4: Fall back to HTML parsing with Cheerio
                if (jobs.length === 0) {
                    jobs = await extractJobDataViaHTML(page);
                    if (jobs.length > 0) {
                        extractionMethod = 'HTML Parsing (Cheerio)';
                        log.info(`HTML parsing successful: ${jobs.length} jobs`);
                    }
                }

                // If still no jobs, save debug info and log page structure
                if (jobs.length === 0) {
                        log.error('No jobs found with ANY extraction method');
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
                        log.info(`Successfully extracted ${jobs.length} jobs using: ${extractionMethod}`);
                    
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
                            log.info(`Saved ${jobsToSave.length} jobs. Total: ${totalJobsScraped}`);
                    }

                    if (maxJobs > 0 && totalJobsScraped >= maxJobs) {
                            log.info(`Reached maximum jobs limit: ${maxJobs}`);
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
    }

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

    log.info('Scraping completed successfully!', statistics);

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
