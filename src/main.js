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

    // Handle Monster's jobViewResultsData structure (nested jobPosting)
    const posting = job.jobPosting || job.normalizedJobPosting || job;
    const hiringOrg = posting.hiringOrganization || {};

    // Extract title
    const title = posting.title || job.jobTitle || job.title || job.name || '';
    if (!title) return null;

    // Extract company
    const company = hiringOrg.name || posting.companyName ||
        job.company || job.companyName || job.hiringCompany ||
        job.companyDisplayName || '';

    // Extract location
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

    // Extract URL
    const jobUrl = job.detailUrl || job.jobViewUrl || posting.url || job.jobUrl || job.url ||
        (job.mesco ? `https://www.monster.com/job-openings/${job.mesco}` : '') ||
        (job.jobId ? `https://www.monster.com/job-openings/${job.jobId}` : '');

    // Extract salary
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

    // Extract job type
    const empType = posting.employmentType || job.employmentType || job.jobType;
    const jobType = Array.isArray(empType) ? empType.join(', ') : empType || 'Not specified';

    // Extract description
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
 * Extract jobs from __NEXT_DATA__ script tag via Playwright
 */
async function extractJobsFromNextData(page) {
    log.info('Extracting jobs from __NEXT_DATA__...');

    try {
        const nextDataContent = await page.evaluate(() => {
            const script = document.getElementById('__NEXT_DATA__');
            return script ? script.textContent : null;
        });

        if (!nextDataContent) {
            log.debug('No __NEXT_DATA__ found');
            return [];
        }

        const data = JSON.parse(nextDataContent);
        const pageProps = data?.props?.pageProps || {};

        log.debug(`pageProps keys: ${Object.keys(pageProps).join(', ')}`);

        // Monster.com primary paths
        const jobArray = pageProps.jobViewResultsData ||
            pageProps.jobViewResultsDataCompact ||
            pageProps.jobResults ||
            pageProps.jobs ||
            pageProps.searchResults?.docs ||
            [];

        if (!Array.isArray(jobArray) || jobArray.length === 0) {
            log.debug('No jobs found in __NEXT_DATA__');
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
 * Extract jobs from JSON-LD structured data via Playwright
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
 * Extract jobs from DOM elements via Playwright (fallback)
 */
async function extractJobsFromDOM(page) {
    log.info('Extracting jobs from DOM elements...');

    try {
        const jobs = await page.evaluate(() => {
            const results = [];

            // Try multiple selectors for job cards
            const selectors = [
                '[data-test-id="svx-job-card"]',
                '[class*="JobCard"]',
                'article[data-job-id]',
                '.job-card'
            ];

            let jobCards = [];
            for (const sel of selectors) {
                jobCards = document.querySelectorAll(sel);
                if (jobCards.length > 0) break;
            }

            jobCards.forEach(card => {
                // Extract title
                const titleEl = card.querySelector('h2 a, h3 a, [data-test-id*="title"] a, a[href*="job-openings"]');
                const title = titleEl?.textContent?.trim() || '';
                const url = titleEl?.href || '';

                // Extract company
                const companyEl = card.querySelector('[data-test-id*="company"], [class*="company"], [class*="Company"]');
                const company = companyEl?.textContent?.trim() || '';

                // Extract location
                const locationEl = card.querySelector('[data-test-id*="location"], [class*="location"], [class*="Location"]');
                const location = locationEl?.textContent?.trim() || '';

                if (title && url) {
                    results.push({
                        title,
                        company,
                        location,
                        salary: 'Not specified',
                        jobType: 'Not specified',
                        postedDate: '',
                        descriptionHtml: '',
                        descriptionText: '',
                        url,
                        scrapedAt: new Date().toISOString()
                    });
                }
            });

            return results;
        });

        if (jobs.length > 0) {
            log.info(`Found ${jobs.length} jobs in DOM`);
        }
        return jobs;
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
 * Main Actor execution
 */
try {
    const input = await Actor.getInput() || {};

    log.info('Starting Monster Jobs Scraper', {
        searchQuery: input.searchQuery,
        location: input.location,
        maxJobs: input.maxJobs
    });

    // Validate input
    if (!input.searchUrl?.trim() && !input.searchQuery?.trim()) {
        throw new Error('Provide either "searchUrl" or "searchQuery"');
    }

    const maxJobs = input.maxJobs ?? 20;
    const maxPages = input.maxPages ?? 3;
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

    // Create Playwright crawler with Camoufox
    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestsPerCrawl: maxPages > 0 ? maxPages : 10,
        maxConcurrency: 1,
        navigationTimeoutSecs: 60,
        requestHandlerTimeoutSecs: 120,

        // Disable fingerprints - Camoufox handles this
        browserPoolOptions: {
            useFingerprints: false,
        },

        launchContext: {
            launcher: firefox,
            launchOptions: await camoufoxLaunchOptions({
                headless: true,
                geoip: true,
                humanize: true,
                os: ['windows', 'macos', 'linux'],
                fonts: ['Arial', 'Helvetica', 'Times New Roman'],
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
                // Human-like delay before navigation
                await page.waitForTimeout(1000 + Math.random() * 2000);

                // Navigate with retry logic
                await page.goto(request.url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 45000,
                });

                // Wait for content to load
                await page.waitForTimeout(3000);

                // Check for Cloudflare/DataDome challenge
                const pageContent = await page.content();
                if (pageContent.includes('Just a moment') || pageContent.includes('Access blocked')) {
                    log.warning('Anti-bot challenge detected, waiting...');
                    await page.waitForTimeout(5000);

                    // Try clicking any challenge buttons
                    try {
                        const challengeBtn = page.locator('input[type="button"], button[type="submit"]').first();
                        if (await challengeBtn.isVisible({ timeout: 2000 })) {
                            await challengeBtn.click();
                            await page.waitForTimeout(5000);
                        }
                    } catch (e) {
                        // No challenge button found
                    }
                }

                let jobs = [];

                // STRATEGY 1: Try __NEXT_DATA__ (most reliable)
                jobs = await extractJobsFromNextData(page);
                if (jobs.length > 0) {
                    extractionMethod = 'NEXT_DATA';
                }

                // STRATEGY 2: Try JSON-LD
                if (jobs.length === 0) {
                    jobs = await extractJobsFromJsonLD(page);
                    if (jobs.length > 0) {
                        extractionMethod = 'JSON-LD';
                    }
                }

                // STRATEGY 3: Try DOM extraction
                if (jobs.length === 0) {
                    jobs = await extractJobsFromDOM(page);
                    if (jobs.length > 0) {
                        extractionMethod = 'DOM';
                    }
                }

                if (jobs.length === 0) {
                    log.warning('No jobs found on this page');

                    // Save debug screenshot
                    const screenshot = await page.screenshot({ fullPage: true });
                    await Actor.setValue('DEBUG_SCREENSHOT', screenshot, { contentType: 'image/png' });

                    const pageTitle = await page.title();
                    log.warning(`Page title: ${pageTitle}`);
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
                    log.info(`Saved ${jobsToSave.length} jobs (total: ${totalJobsScraped})`);
                }

            } catch (error) {
                log.error(`Page processing failed: ${error.message}`);

                // Save debug info
                try {
                    const screenshot = await page.screenshot();
                    await Actor.setValue('ERROR_SCREENSHOT', screenshot, { contentType: 'image/png' });
                } catch (e) {
                    // Ignore screenshot errors
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
