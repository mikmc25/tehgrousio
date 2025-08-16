/**
 * STREAM_SOURCES with automatic proxy wrapping via proxyIfLocalAvailable
 * Applies wrapping dynamically without requiring caller to manually wrap each URL.
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

async function proxyIfLocalAvailable(url) {
    const proxyBase = 'http://127.0.0.1:11470/proxy/';
    try {
        if (!/^https?:/.test(url)) return url;

        const testProxy = await fetch(proxyBase + encodeURIComponent('https://stremio.com'), {
            method: 'HEAD',
            mode: 'no-cors'
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
  hankchin_aboxin: {
    url : 'https://banya.h-y.workers.dev',
    name: '🛀🏻BΛПYΛ☭'
  },
  hankchin_aboxin2: {
    url : 'https://hankchin-aboxin2.hf.space',
    name: '🛀🏻BΛПYΛ☭'
  },  
  cf_torr9: {
    url: 'https://torr9.h-y.workers.dev',
    name: '🛀🏻BΛПYΛ☭'
  },
  cf_yts: {
    url : 'https://ezseries.h-y.workers.dev',
    name: '🛀🏻BΛПYΛ☭'
  },
  mikmc5_dockertool: {
    url : 'https://magnet.h-y.workers.dev',
    name: '🛀🏻BΛПYΛ☭'
  }
};

// Export the static STREAM_SOURCES for immediate use (for compatibility)
export const STREAM_SOURCES = RAW_STREAM_SOURCES;

/**
 * Returns STREAM_SOURCES with proxy-wrapped URLs applied at runtime.
 * Call this before using the sources.
 */
export async function getProxiedStreamSources() {
    const wrapped = {};
    for (const [key, source] of Object.entries(RAW_STREAM_SOURCES)) {
        wrapped[key] = {
            ...source,
            url: await proxyIfLocalAvailable(source.url)
        };
    }
    return wrapped;
}