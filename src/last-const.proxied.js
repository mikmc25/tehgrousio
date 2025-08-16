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
    cf_1337: {
    url : 'https://1337x.h-y.workers.dev',
    name: '1️3️⃣3️⃣7️⃣'
    },
    cf_bitsearch: {
    url : 'https://bobbysands5-bungal.hf.space',
    name: '𝓑𝓲𝓽𝓢𝓮𝓪𝓻𝓬𝓱'
    },
    cf_btsow: {
    url : 'https://bobbysands5-bunt9.hf.space',
    name: '𝐁𝐓𝐒𝐨𝐰'
    },
    cf_bt4: {
    url : 'https://bobbysands5-bunin.hf.space',
    name: '𝐁𝐓𝟒𝐆𝐏𝐑𝐗'
    },
    cf_eztv: {
    url : 'https://ezseries.h-y.workers.dev',
    name: '𝐄𝐙𝐓𝐕 🖥️'
    },
    cf_rutrack: {
    url: 'https://testittv.h-y.workers.dev',
    name: '☭🇷🇺Tɾαƈƙҽɾ'
    }, 
    cf_tdown: {
    url : 'https://tdown.h-y.workers.dev',
    name: '❝𝐓𝐨𝐫𝐫𝐞𝐧𝐭𝐃𝐨𝐰𝐧𝐥𝐨𝐚𝐝❞'
   },
   cf_tpb: {
    url : 'https://odtpb.h-y.workers.dev',
    name: '❝𝓣𝓟𝓑❞'
   },  
   cf_torr9: {
    url: 'https://hankchin-animai3.hf.space',
    name: 'anƬӨЯЯΣПƬZ9'
   },
   cf_uindex: {
    url : 'https://hankchin-aboxin.hf.space',
    name: '【ＵＩＮＤＥＸ】'
   },
   cf_yts: {
    url : 'https://yts.h-y.workers.dev',
    name: 'ＹＴＳ．ＭＸ'
   },
   mikmc5_dockertool: {
    url : 'https://joe-mc-donnell-cyber.hf.space',
    name: 'ＭΛＧＮΣＴＤＬ'
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