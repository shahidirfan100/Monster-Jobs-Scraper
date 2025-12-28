import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';

// Initialize the Apify SDK
await Actor.init();

/**
 * Strip HTML tags from string
 */
function stripHtml(html) {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Normalize Monster job object from __NEXT_DATA__ or API response
 */
function normalizeMonsterJob(job) {
    if (!job) return null;

    const posting = job.jobPosting || job.normalizedJobPosting || job;
    const hiringOrg = posting.hiringOrganization || {};

    const title = posting.title || job.jobTitle || job.title || job.name || '';
    if (!title) return null;

    const company = hiringOrg.name || posting.companyName ||
        job.company || job.companyName || job.hiringCompany ||
        job.companyDisplayName || '';

    let location = '';
    const jobLocations = posting.jobLocation || job.jobLocation;
    if (Array.isArray(jobLocations) && jobLocations.length > 0) {
        const addr = jobLocations[0].address || jobLocations[0];
        location = [addr.addressLocality, addr.addressRegion, addr.addressCountry]
            .filter(Boolean).join(', ');
    } else if (typeof jobLocations === 'object' && jobLocations !== null) {
        const addr = jobLocations.address || jobLocations;
        location = [addr.addressLocality || addr.city, addr.addressRegion || addr.state]
            .filter(Boolean).join(', ');
    } else {
        location = job.location || job.city || '';
    }

    const jobUrl = job.detailUrl || job.jobViewUrl || posting.url || job.jobUrl || job.url ||
        (job.mesco ? `https://www.monster.com/job-openings/${job.mesco}` : '') ||
        (job.jobId ? `https://www.monster.com/job-openings/${job.jobId}` : '');

    let salary = 'Not specified';
    const baseSalary = posting.baseSalary || job.baseSalary;
    if (baseSalary?.value) {
        const sv = baseSalary.value;
        if (sv.minValue || sv.maxValue) {
            salary = `${sv.minValue || ''}${sv.maxValue ? ` - ${sv.maxValue}` : ''} ${baseSalary.currency || ''}`.trim();
        }
    } else if (job.salary) {
        salary = job.salary;
    }

    const empType = posting.employmentType || job.employmentType || job.jobType;
    const jobType = Array.isArray(empType) ? empType.join(', ') : empType || 'Not specified';

    const description = posting.description || job.description || job.snippet || '';

    return {
        title,
        company,
        location,
        salary,
        jobType,
        postedDate: posting.datePosted || job.postedDate || job.datePosted || '',
        descriptionHtml: description,
        descriptionText: stripHtml(description),
        url: jobUrl,
        scrapedAt: new Date().toISOString()
    };
}

/**
 * Extract jobs from __NEXT_DATA__ script tag
 */
async function extractJobsFromNextData(page) {
    log.info('Extracting jobs from __NEXT_DATA__...');

    try {
        const nextDataContent = await page.evaluate(() => {
            const script = document.getElementById('__NEXT_DATA__');
            return script ? script.textContent : null;
        });

        if (!nextDataContent) {
            log.info('⚠️ No __NEXT_DATA__ script found in page');
            return [];
        }

        const data = JSON.parse(nextDataContent);
        const pageProps = data?.props?.pageProps || {};

        // Show what keys are available (INFO level for debugging)
        log.info(`📊 __NEXT_DATA__ pageProps keys: ${Object.keys(pageProps).join(', ')}`);

        const jobArray = pageProps.jobViewResultsData ||
            pageProps.jobViewResultsDataCompact ||
            pageProps.jobResults ||
            pageProps.jobs ||
            pageProps.searchResults?.docs ||
            [];

        if (!Array.isArray(jobArray) || jobArray.length === 0) {
            log.info(`⚠️ No jobs found in __NEXT_DATA__. Tried: jobViewResultsData, jobViewResultsDataCompact, jobResults, jobs, searchResults.docs`);
            return [];
        }

        log.info(`Found ${jobArray.length} jobs in __NEXT_DATA__`);

        const jobs = jobArray.map(normalizeMonsterJob).filter(Boolean);
        log.info(`Normalized ${jobs.length} valid jobs`);

        return jobs;
    } catch (error) {
        log.warning(`Failed to extract from __NEXT_DATA__: ${error.message}`);
        return [];
    }
}

/**
 * Extract jobs from JSON-LD structured data
 */
async function extractJobsFromJsonLD(page) {
    log.info('Extracting jobs from JSON-LD...');

    try {
        const jsonLdScripts = await page.$$eval('script[type="application/ld+json"]', scripts =>
            scripts.map(s => s.textContent)
        );

        const jobs = [];
        for (const content of jsonLdScripts) {
            try {
                const data = JSON.parse(content);
                if (data['@type'] === 'JobPosting') {
                    const job = normalizeMonsterJob(data);
                    if (job) jobs.push(job);
                } else if (Array.isArray(data['@graph'])) {
                    for (const item of data['@graph']) {
                        if (item['@type'] === 'JobPosting') {
                            const job = normalizeMonsterJob(item);
                            if (job) jobs.push(job);
                        }
                    }
                }
            } catch (e) {
                log.debug(`Failed to parse JSON-LD: ${e.message}`);
            }
        }

        if (jobs.length > 0) {
            log.info(`Found ${jobs.length} jobs in JSON-LD`);
        }
        return jobs;
    } catch (error) {
        log.warning(`JSON-LD extraction failed: ${error.message}`);
        return [];
    }
}

/**
 * Extract jobs from DOM elements (fallback)
 */
async function extractJobsFromDOM(page) {
    log.info('Extracting jobs from DOM elements...');

    try {
        const jobs = await page.evaluate(() => {
            const results = [];

            const selectors = [
                '[data-test-id="svx-job-card"]',
                '[class*="JobCard"]',
                'article[data-job-id]',
                '.job-card'
            ];

            let jobCards = [];
            let matchedSelector = '';
            for (const sel of selectors) {
                jobCards = document.querySelectorAll(sel);
                if (jobCards.length > 0) {
                    matchedSelector = sel;
                    break;
                }
            }

            jobCards.forEach(card => {
                // Title and URL
                const titleEl = card.querySelector('h2 a, h3 a, [data-test-id*="title"] a, a[href*="job-openings"]');
                const title = titleEl?.textContent?.trim() || '';
                const url = titleEl?.href || '';

                // Company - try multiple selectors
                const companySelectors = [
                    '[data-test-id="svx-job-card-company"]',
                    '[data-test-id*="company"]',
                    '[class*="company" i]',
                    '[class*="Company"]',
                    'h4',
                    '.company-name',
                    'div[data-test-id*="company"] span'
                ];
                let company = '';
                for (const sel of companySelectors) {
                    const el = card.querySelector(sel);
                    if (el && el.textContent.trim()) {
                        company = el.textContent.trim();
                        break;
                    }
                }

                // Location
                const locationSelectors = [
                    '[data-test-id="svx-job-card-location"]',
                    '[data-test-id*="location"]',
                    '[class*="location" i]',
                    '[class*="Location"]',
                    '.location'
                ];
                let location = '';
                for (const sel of locationSelectors) {
                    const el = card.querySelector(sel);
                    if (el && el.textContent.trim()) {
                        location = el.textContent.trim();
                        break;
                    }
                }

                // Description/snippet
                const descSelectors = [
                    '[data-test-id="svx-job-card-summary"]',
                    '[class*="summary" i]',
                    '[class*="description" i]',
                    '[class*="snippet" i]',
                    'p'
                ];
                let description = '';
                for (const sel of descSelectors) {
                    const el = card.querySelector(sel);
                    if (el && el.textContent.trim()) {
                        description = el.textContent.trim();
                        break;
                    }
                }

                // Salary
                const salarySelectors = [
                    '[data-test-id*="salary"]',
                    '[class*="salary" i]',
                    '[class*="compensation" i]'
                ];
                let salary = 'Not specified';
                for (const sel of salarySelectors) {
                    const el = card.querySelector(sel);
                    if (el && el.textContent.trim()) {
                        salary = el.textContent.trim();
                        break;
                    }
                }

                if (title && url) {
                    results.push({
                        title,
                        company: company || 'Not specified',
                        location: location || 'Not specified',
                        salary,
                        jobType: 'Not specified',
                        postedDate: '',
                        descriptionHtml: description,
                        descriptionText: description, // Same as HTML for now
                        url,
                        scrapedAt: new Date().toISOString()
                    });
                }
            });

            return { results, matchedSelector };
        });

        const jobResults = jobs.results || [];
        if (jobResults.length > 0) {
            log.info(`Found ${jobResults.length} jobs in DOM using selector: ${jobs.matchedSelector}`);
        }
        return jobResults;
    } catch (error) {
        log.warning(`DOM extraction failed: ${error.message}`);
        return [];
    }
}

/**
 * Build Monster.com search URL from input
 */
function buildSearchUrl(input) {
    if (input.searchUrl?.trim()) {
        return input.searchUrl.trim();
    }

    const params = new URLSearchParams();
    if (input.searchQuery) params.append('q', input.searchQuery);
    if (input.location) params.append('where', input.location);
    params.append('page', '1');
    params.append('so', input.sortBy === 'date' ? 'm.h.s' : 'm.h.sh');

    return `https://www.monster.com/jobs/search?${params.toString()}`;
}

/**
 * Human-like mouse movements
 */
async function humanMouseMove(page) {
    const viewportSize = await page.viewportSize();
    if (!viewportSize) return;

    const { width, height } = viewportSize;

    // Random starting position
    let x = Math.random() * width * 0.8 + width * 0.1;
    let y = Math.random() * height * 0.8 + height * 0.1;

    // Move mouse in natural curves
    for (let i = 0; i < 3; i++) {
        const targetX = Math.random() * width * 0.6 + width * 0.2;
        const targetY = Math.random() * height * 0.6 + height * 0.2;

        await page.mouse.move(targetX, targetY, { steps: 10 + Math.floor(Math.random() * 20) });
        await page.waitForTimeout(100 + Math.random() * 200);
    }
}

/**
 * Main Actor execution
 */
try {
    const input = await Actor.getInput() || {};

    log.info('Starting Monster Jobs Scraper', {
        searchQuery: input.searchQuery,
        location: input.location,
        maxJobs: input.maxJobs
    });

    if (!input.searchUrl?.trim() && !input.searchQuery?.trim()) {
        throw new Error('Provide either "searchUrl" or "searchQuery"');
    }

    const maxJobs = input.maxJobs ?? 20;
    const maxPages = input.maxPages ?? 3;
    const searchUrl = buildSearchUrl(input);

    log.info(`Search URL: ${searchUrl}`);

    // Create proxy configuration - FORCE RESIDENTIAL for DataDome bypass
    const proxyConfiguration = await Actor.createProxyConfiguration(
        input.proxyConfiguration || {
            useApifyProxy: true,
            groups: ['RESIDENTIAL'], // Force residential IPs
            countryCode: 'US', // US residential IPs
            checkAccess: true
        }
    );

    let totalJobsScraped = 0;
    let pagesProcessed = 0;
    let extractionMethod = 'None';
    const startTime = Date.now();
    const seenJobUrls = new Set();

    log.info('Starting crawler with Camoufox (Apify template pattern)...');

    // Create Playwright crawler
    const crawler = new PlaywrightCrawler({
        // Pass proxy configuration - PlaywrightCrawler will handle it
        proxyConfiguration,
        maxRequestsPerCrawl: maxPages > 0 ? maxPages : 10,
        maxConcurrency: 1,
        navigationTimeoutSecs: 120,
        requestHandlerTimeoutSecs: 300,
        maxRequestRetries: 5,

        // Browser pool options for Camoufox
        browserPoolOptions: {
            useFingerprints: false, // Camoufox handles fingerprinting
            retireBrowserAfterPageCount: 1, // Fresh browser for each request
        },

        launchContext: {
            launcher: firefox,
            // EXACT Apify template pattern for launchOptions
            launchOptions: await camoufoxLaunchOptions({
                headless: true,
                proxy: await proxyConfiguration.newUrl(), // Pass proxy URL to Camoufox
                geoip: true,
                humanize: true,
                screen: {
                    minWidth: 1280,
                    maxWidth: 1920,
                    minHeight: 720,
                    maxHeight: 1080,
                },
            }),
        },

        // Pre-navigation hook for additional stealth
        preNavigationHooks: [
            async ({ page }) => {
                // Set realistic viewport
                await page.setViewportSize({
                    width: 1366 + Math.floor(Math.random() * 200),
                    height: 768 + Math.floor(Math.random() * 100),
                });

                // Set extra headers
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1',
                    'Cache-Control': 'max-age=0',
                });
            },
        ],

        async requestHandler({ page, request }) {
            pagesProcessed++;
            log.info(`Processing page ${pagesProcessed}: ${request.url}`);

            try {
                // WARMUP: Visit homepage first to build session history (anti-DataDome)
                if (pagesProcessed === 1) {
                    log.info('Warmup: Visiting Monster.com homepage to build session...');
                    await page.goto('https://www.monster.com', {
                        waitUntil: 'domcontentloaded',
                        timeout: 60000,
                    });

                    // Browse homepage naturally
                    await page.waitForTimeout(3000 + Math.random() * 2000);
                    await humanMouseMove(page);
                    await page.evaluate(() => window.scrollBy(0, 300));
                    await page.waitForTimeout(2000 + Math.random() * 1000);

                    log.info('Warmup complete, now navigating to search page...');
                    await page.waitForTimeout(2000 + Math.random() * 2000);
                }

                // Extended pre-navigation delay
                const preDelay = 5000 + Math.random() * 5000;
                log.debug(`Pre-navigation delay: ${Math.round(preDelay)}ms`);
                await page.waitForTimeout(preDelay);

                // Navigate to target
                await page.goto(request.url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 90000,
                });

                // Human-like mouse movements
                await humanMouseMove(page);

                // Wait for page to settle
                await page.waitForTimeout(4000 + Math.random() * 3000);

                // Check for anti-bot challenges
                const pageContent = await page.content();
                const pageTitle = await page.title();

                const isBlocked = pageContent.includes('Just a moment') ||
                    pageContent.includes('Access blocked') ||
                    pageContent.includes('Enable JavaScript') ||
                    pageContent.includes('Pardon Our Interruption') ||
                    pageTitle.toLowerCase().includes('cloudflare') ||
                    pageTitle.toLowerCase().includes('blocked');

                if (isBlocked) {
                    log.warning('Anti-bot challenge detected, attempting bypass...');

                    // Extended wait with mouse movements
                    for (let i = 0; i < 3; i++) {
                        await humanMouseMove(page);
                        await page.waitForTimeout(3000 + Math.random() * 2000);
                    }

                    // Try scrolling
                    await page.evaluate(() => {
                        window.scrollBy(0, 300);
                    });
                    await page.waitForTimeout(2000);

                    // Check again
                    const newContent = await page.content();
                    if (newContent.includes('Just a moment') || newContent.includes('Access blocked')) {
                        log.error('Failed to bypass anti-bot challenge');
                        const screenshot = await page.screenshot({ fullPage: true });
                        await Actor.setValue('BLOCKED_SCREENSHOT', screenshot, { contentType: 'image/png' });
                        return;
                    }
                    log.info('Anti-bot challenge bypassed!');
                }

                // Additional scroll to trigger lazy loading
                await page.evaluate(() => window.scrollBy(0, 500));
                await page.waitForTimeout(2000);

                let jobs = [];

                // STRATEGY 1: __NEXT_DATA__
                jobs = await extractJobsFromNextData(page);
                if (jobs.length > 0) {
                    extractionMethod = 'NEXT_DATA';
                }

                // STRATEGY 2: JSON-LD
                if (jobs.length === 0) {
                    jobs = await extractJobsFromJsonLD(page);
                    if (jobs.length > 0) {
                        extractionMethod = 'JSON-LD';
                    }
                }

                // STRATEGY 3: DOM
                if (jobs.length === 0) {
                    jobs = await extractJobsFromDOM(page);
                    if (jobs.length > 0) {
                        extractionMethod = 'DOM';
                    }
                }

                if (jobs.length === 0) {
                    log.warning('No jobs found on this page');

                    // Save debug data
                    const screenshot = await page.screenshot({ fullPage: true });
                    const html = await page.content();
                    await Actor.setValue('DEBUG_SCREENSHOT', screenshot, { contentType: 'image/png' });
                    await Actor.setValue('DEBUG_HTML', html, { contentType: 'text/html' });

                    log.warning(`Page title: ${pageTitle}`);
                    log.warning(`Page URL: ${page.url()}`);
                    log.warning('Saved DEBUG_SCREENSHOT and DEBUG_HTML to key-value store for inspection');
                    return;
                }

                // Filter duplicates and apply limit
                let jobsToSave = [];
                for (const job of jobs) {
                    if (maxJobs > 0 && totalJobsScraped + jobsToSave.length >= maxJobs) break;

                    const key = job.url || `${job.title}-${job.company}`;
                    if (!seenJobUrls.has(key)) {
                        seenJobUrls.add(key);
                        jobsToSave.push(job);
                    }
                }

                if (jobsToSave.length > 0) {
                    await Actor.pushData(jobsToSave);
                    totalJobsScraped += jobsToSave.length;
                    log.info(`✓ Saved ${jobsToSave.length} jobs (total: ${totalJobsScraped})`);
                }

            } catch (error) {
                log.error(`Page processing failed: ${error.message}`);
                try {
                    const screenshot = await page.screenshot();
                    await Actor.setValue('ERROR_SCREENSHOT', screenshot, { contentType: 'image/png' });
                } catch (e) {
                    // Ignore
                }
            }
        },

        async failedRequestHandler({ request, error }) {
            log.error(`Request failed: ${request.url} - ${error.message}`);
        },
    });

    log.info('Starting Playwright crawler with Camoufox...');
    await crawler.run([{ url: searchUrl }]);

    const duration = Math.round((Date.now() - startTime) / 1000);

    log.info('Scraping completed!', {
        totalJobsScraped,
        pagesProcessed,
        extractionMethod,
        duration: `${duration} seconds`
    });

    if (totalJobsScraped === 0) {
        log.warning('No jobs were scraped. Check the DEBUG_SCREENSHOT in key-value store.');
    }

} catch (error) {
    log.error(`Actor failed: ${error.message}`);
    throw error;
} finally {
    await Actor.exit();
}
