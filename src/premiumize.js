// premiumize.js
import { ERROR } from './const.js';
import { BaseDebrid, findBestFile } from './base-debrid.js';

export class Premiumize extends BaseDebrid {
    #apiUrl = 'https://www.premiumize.me/api';
    #batchSize = 99;

    constructor(apiKey) {
        super(apiKey, 'pr');
    }

    static canHandle(apiKey) {
        return apiKey.startsWith('pr=');
    }

    async makeRequest(method, path, opts = {}) {
        const retries = 3;
        let lastError;

        for (let i = 0; i < retries; i++) {
            try {
                const url = `${this.#apiUrl}${path}`;
                console.log(`\n🔷 Premiumize Request (Attempt ${i + 1}/${retries}):`, method, path);
                if (opts.body) console.log('Request Body:', opts.body);

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 30000);

                if (method === 'POST' && opts.body instanceof FormData) {
                    opts.body.append('apikey', this.getKey());
                }

                const finalUrl = method === 'GET' 
                    ? `${url}${url.includes('?') ? '&' : '?'}apikey=${this.getKey()}`
                    : url;

                const startTime = Date.now();
                const response = await fetch(finalUrl, {
                    ...opts,
                    method,
                    signal: controller.signal
                });

                clearTimeout(timeout);
                console.log(`Response Time: ${Date.now() - startTime}ms`);
                console.log('Response Status:', response.status);

                const data = await response.json();
                console.log('Response Data:', data);

                if (data.status === 'error') {
                    if (data.message === 'Invalid API key.') {
                        throw new Error(ERROR.INVALID_API_KEY);
                    }
                    throw new Error(`API Error: ${data.message}`);
                }

                return data;

            } catch (error) {
                console.log(`Attempt ${i + 1} failed:`, error.message);
                lastError = error;
                if (i < retries - 1) {
                    console.log('Retrying after 2 seconds...');
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }

        throw lastError;
    }

    async checkCacheStatuses(hashes) {
        try {
            console.log(`\n📡 Premiumize: Batch checking ${hashes.length} hashes`);
            console.log('Processing in batches of', this.#batchSize);

            const results = {};
            const batches = [];

            for (let i = 0; i < hashes.length; i += this.#batchSize) {
                batches.push(hashes.slice(i, i + this.#batchSize));
            }

            console.log(`Split into ${batches.length} batches`);

            for (let i = 0; i < batches.length; i++) {
                const batch = batches[i];
                console.log(`\nProcessing batch ${i + 1}/${batches.length} (${batch.length} hashes)`);

                const params = new URLSearchParams();
                batch.forEach(hash => params.append('items[]', hash));

                const data = await this.makeRequest('GET', `/cache/check?${params}`);

                batch.forEach((hash, index) => {
                    results[hash] = {
                        cached: data.response[index],
                        files: [],
                        fileCount: 0,
                        service: 'Premiumize' // Mark as Premiumize service
                    };
                });

                if (i < batches.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }

            const cachedCount = Object.values(results).filter(r => r.cached).length;
            console.log(`\nPremiumize found ${cachedCount} cached torrents out of ${hashes.length}`);

            return results;

        } catch (error) {
            console.error('Cache check failed:', error);
            return {};
        }
    }

    async getStreamUrl(magnetLink) {
        try {
            console.log('\n📥 Using Premiumize to process magnet:', magnetLink.substring(0, 100) + '...');
            
            const body = new FormData();
            body.append('src', magnetLink);

            const data = await this.makeRequest('POST', '/transfer/directdl', { body });

            // Extract potential media info from magnet title
            const mediaInfo = this.extractMediaInfo(magnetLink);
            console.log('Extracted media info:', mediaInfo);
            
            const bestFile = findBestFile(
                data.content,
                mediaInfo.type,
                mediaInfo
            );

            if (!bestFile) {
                console.error('No suitable video file found');
                throw new Error('No suitable video file found');
            }

            console.log('Selected file for streaming:', bestFile.path);
            return bestFile.stream_link || bestFile.link;
        } catch (error) {
            console.error('❌ Failed to get stream URL:', error);
            throw error;
        }
    }
}