/**
 * STREAM_SOURCES with automatic proxy wrapping via multiple proxy fallbacks
 * Applies wrapping dynamically with DNS-safe fetch and multiple proxy options.
 */

// Error constants
export const ERROR = {
    NOT_PREMIUM: 'NOT_PREMIUM',
    TORRENT_NOT_CACHED: 'TORRENT_NOT_CACHED',
    INVALID_MAGNET: 'INVALID_MAGNET',
    API_ERROR: 'API_ERROR',
    RATE_LIMITED: 'RATE_LIMITED',
    ACTIVE_LIMIT: 'ACTIVE_LIMIT',
    DOWNLOAD_LIMIT: 'DOWNLOAD_LIMIT'
};

// Multiple proxy options to try
const PROXY_OPTIONS = [
    'https://cloudproxy2.h-y.workers.dev/?url=',           // Local proxy
    'https://cors-proxy.viren070.me/?url=',     // Public CORS proxy
    'https://api.allorigins.win/raw?url=',      // AllOrigins proxy
    'https://corsproxy.io/?',                   // CorsProxy.io
    'https://proxy.cors.sh/',                   // CORS.sh proxy
];

// DNS-resilient fetch function (copied from your main file)
import { lookup } from 'node:dns/promises';
import http from 'http';
import https from 'https';

async function fetchWithSafeDNS(url, options = {}) {
    try {
        const { hostname } = new URL(url);
        const { address } = await lookup(hostname);
        const agent = url.startsWith('https')
            ? new https.Agent({ lookup: (_, __, cb) => cb(null, address, 4) })
            : new http.Agent({ lookup: (_, __, cb) => cb(null, address, 4) });
        
        // Use dynamic import for node-fetch to handle different environments
        const fetch = options.fetch || (await import('node-fetch')).default;
        return fetch(url, { ...options, agent });
    } catch (error) {
        console.error('DNS-safe fetch failed:', error);
        // Fallback to regular fetch
        const fetch = options.fetch || (await import('node-fetch')).default;
        return fetch(url, options);
    }
}

// Enhanced proxy function with multiple fallbacks and DNS-safe fetch
async function proxyWithMultipleFallbacks(originalUrl, customFetch = null) {
    if (!/^https?:/.test(originalUrl)) return originalUrl;

    const fetchFunction = customFetch || (globalThis.fetch || (await import('node-fetch')).default);
    
    // First try direct connection with DNS-safe fetch
    try {
        console.debug('[proxyWithMultipleFallbacks] Trying direct connection:', originalUrl);
        const directResponse = await fetchWithSafeDNS(originalUrl, { 
            method: 'HEAD',
            timeout: 5000,
            fetch: fetchFunction
        });
        
        if (directResponse.ok) {
            console.debug('[proxyWithMultipleFallbacks] Direct connection successful');
            return originalUrl;
        }
    } catch (error) {
        console.debug('[proxyWithMultipleFallbacks] Direct connection failed:', error.message);
    }

    // Try each proxy option
    for (const proxyBase of PROXY_OPTIONS) {
        try {
            const testUrl = proxyBase === 'https://api.allorigins.win/raw?url=' 
                ? proxyBase + encodeURIComponent('https://httpbin.org/status/200')
                : proxyBase + encodeURIComponent('https://httpbin.org/status/200');
                
            console.debug('[proxyWithMultipleFallbacks] Testing proxy:', proxyBase);
            
            const testResponse = await fetchFunction(testUrl, {
                method: 'HEAD',
                timeout: 5000,
                mode: 'no-cors'
            });

            // Check if proxy is working (accept opaque responses for CORS proxies)
            if (testResponse.ok || testResponse.status === 200 || testResponse.type === 'opaque') {
                const proxiedUrl = proxyBase + encodeURIComponent(originalUrl);
                console.debug('[proxyWithMultipleFallbacks] Using proxy:', proxyBase, 'for URL:', originalUrl);
                return proxiedUrl;
            }
        } catch (error) {
            console.debug('[proxyWithMultipleFallbacks] Proxy failed:', proxyBase, error.message);
            continue;
        }
    }

    // If all proxies fail, return original URL
    console.debug('[proxyWithMultipleFallbacks] All proxies failed, using original URL');
    return originalUrl;
}

// Alternative simple proxy function for basic CORS bypass
async function proxyIfLocalAvailable(url) {
    const proxyBase = 'http://127.0.0.1:11470/proxy/';
    try {
        if (!/^https?:/.test(url)) return url;

        const testProxy = await fetch(proxyBase + encodeURIComponent('https://stremio.com'), {
            method: 'HEAD',
            mode: 'no-cors',
            timeout: 3000
        });

        if (testProxy.ok || testProxy.status === 200 || testProxy.type === 'opaque') {
            const proxiedUrl = proxyBase + encodeURIComponent(url);
            console.debug('[proxyIfLocalAvailable] Proxying through localhost:', proxiedUrl);
            return proxiedUrl;
        }
    } catch (err) {
        console.debug('[proxyIfLocalAvailable] Proxy fallback. Error:', err.message);
    }
    return url;
}

const RAW_STREAM_SOURCES = {
  cf_1337: {
    url : 'https://1337x.h-y.workers.dev',
    name: '1️3️⃣3️⃣7️⃣',
  },
  cf_bitsearch: {
    url : 'https://jacred.h-y.workers.dev',
    name: '𝓑𝓲𝓽𝓢𝓮𝓪𝓻𝓬𝓱',
  },
  cf_btsow: {
    url : 'https://chrome-en.h-y.workers.dev',
    name: '𝐁𝐓𝐒𝐨𝐰',
  },
  cf_bt4: {
    url : 'https://uhdnews.h-y.workers.dev',
    name: '𝐁𝐓𝟒𝐆𝐏𝐑𝐗',
  },
  cf_eztv: {
    url : 'https://ezseries.h-y.workers.dev',
    name: '𝐄𝐙𝐓𝐕 🖥️',
  },
  cf_extto: {
    url : 'https://extto.h-y.workers.dev',
    name: 'Ｅｘｔｔｏ',
  },
  cf_glodls: {
    url : 'https://glodls.h-y.workers.dev',
    name: 'Gl🌞DLS',
  },
   cf_rutrack: {
    url: 'https://rutrack.h-y.workers.dev',
    name: '☭🇷🇺Tɾαƈƙҽɾ',
  }, 
  cf_tdown: {
    url : 'https://tdown.h-y.workers.dev',
    name: '❝𝐓𝐨𝐫𝐫𝐞𝐧𝐭𝐃𝐨𝐰𝐧𝐥𝐨𝐚𝐝❞',
  },
  cf_tpb: {
    url : 'https://odtpb.h-y.workers.dev',
    name: '❝𝓣𝓟𝓑❞',
  },  
  cf_torr9: {
    url: 'https://torr9.h-y.workers.dev',
    name: 'ƬӨЯЯΣПƬZ9',
  },
  cf_uindex: {
    url : 'https://uindex.h-y.workers.dev',
    name: '【ＵＩＮＤＥＸ】'
  },
  cf_yts: {
    url : 'https://yts.h-y.workers.dev',
    name: 'ＹＴＳ．ＭＸ',
  },
  mikmc5_dockertool: {
    url : 'https://magnet.h-y.workers.dev',
    name: 'ＭΛＧＮΣＴＤＬ',
  }
};

// Export the static STREAM_SOURCES for immediate use (for compatibility)
export const STREAM_SOURCES = RAW_STREAM_SOURCES;

/**
 * Returns STREAM_SOURCES with proxy-wrapped URLs applied at runtime.
 * Uses multiple proxy fallbacks and DNS-safe fetch.
 */
export async function getProxiedStreamSources(customFetch = null) {
    const wrapped = {};
    for (const [key, source] of Object.entries(RAW_STREAM_SOURCES)) {
        wrapped[key] = {
            ...source,
            url: await proxyWithMultipleFallbacks(source.url, customFetch)
        };
    }
    return wrapped;
}

/**
 * Simple proxy version for basic CORS bypass (backwards compatibility)
 */
export async function getSimpleProxiedStreamSources() {
    const wrapped = {};
    for (const [key, source] of Object.entries(RAW_STREAM_SOURCES)) {
        wrapped[key] = {
            ...source,
            url: await proxyIfLocalAvailable(source.url)
        };
    }
    return wrapped;
}

/**
 * Enhanced fetch function that combines DNS-safe fetch with proxy fallbacks
 */
export async function enhancedFetch(url, options = {}) {
    // First try with DNS-safe fetch
    try {
        return await fetchWithSafeDNS(url, options);
    } catch (error) {
        console.debug('Enhanced fetch: DNS-safe fetch failed, trying proxy fallbacks');
        
        // Try with proxy fallbacks
        const proxiedUrl = await proxyWithMultipleFallbacks(url, options.fetch);
        const fetchFunction = options.fetch || (globalThis.fetch || (await import('node-fetch')).default);
        return fetchFunction(proxiedUrl, { ...options, agent: undefined });
    }
}