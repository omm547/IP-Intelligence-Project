require('dotenv').config();
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const net = require('net');

const app = express();
app.use(express.json({ limit: '5mb' }));

// Simple request logger and CORS handler to support preflight requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()}  ${req.method} ${req.url}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const STATIC_DIR = path.join(__dirname, 'static');
const MAX_BULK_IPS = 2000;
// Default concurrent requests to the external API. Tune via CONCURRENCY env var.
const DEFAULT_CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 10;

// In-memory cache for IP lookup results
const ipCache = new Map();
const CACHE_TTL = 3600 * 1000; // 1 hour TTL

const IP2LOCATION_KEY = process.env.IP2LOCATION_KEY || '';
const IP2LOCATION_API_URL = 'https://api.ip2location.io/';

async function fetch_ip2location_info(ip) {
  const params = new URLSearchParams({
    ip: ip,
    format: 'json'
  });
  if (IP2LOCATION_KEY) {
    params.append('key', IP2LOCATION_KEY);
  }

  const resp = await fetch(`${IP2LOCATION_API_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(5000)
  });
  if (!resp.ok) {
    if (resp.status === 429) throw new Error('IP2Location.io Rate limit exceeded');
    throw new Error(`IP2Location.io API error: ${resp.status}`);
  }

  const data = await resp.json();
  if (data.error) {
    throw new Error(data.error.error_message || 'IP2Location.io API error');
  }

  return data;
}

// â”€â”€â”€ FreeIPAPI Integration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function fetch_freeipapi_info(ip) {
  const url = `https://freeipapi.com/api/json/${ip}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!resp.ok) throw new Error(`FreeIPAPI error: ${resp.status}`);
  const data = await resp.json();

  return {
    ip: data.ipAddress,
    version: data.ipVersion,
    type: data.isProxy ? 'Proxy/VPN' : 'Residential',
    continent: data.continent,
    country: data.countryName,
    country_code: data.countryCode,
    region: data.regionName,
    city: data.cityName,
    latitude: data.latitude,
    longitude: data.longitude,
    is_eu: null, // Not provided
    postal: data.zipCode,
    timezone: data.timeZone,
    isp: data.asName,
    asn: data.asn,
    org: data.asName,
    security: {
      vpn: data.isProxy,
      proxy: data.isProxy,
      tor: false,
      hosting: false,
      anonymous: data.isProxy
    },
    privacy_status: data.isProxy ? 'Proxy/VPN' : 'Clean',
    raw: data
  };
}

// â”€â”€â”€ IP-API Batch Integration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function fetch_ipapi_batch(ips) {
  const url = 'http://ip-api.com/batch?fields=status,message,continent,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,query,proxy,hosting';
  const resp = await fetch(url, {
    method: 'POST',
    body: JSON.stringify(ips.map(ip => ({ query: ip }))),
    signal: AbortSignal.timeout(10000)
  });
  if (!resp.ok) throw new Error(`IP-API batch error: ${resp.status}`);
  const data = await resp.json();

  return data.map((item, idx) => {
    if (item.status === 'fail') return { ip: ips[idx], ok: false, error: item.message };

    // Extract ASN from "AS1234 Organization Name"
    const asMatch = item.as ? item.as.match(/^AS(\d+)/) : null;
    const asn = asMatch ? asMatch[1] : null;

    return {
      ip: item.query,
      ok: true,
      data: {
        ip: item.query,
        version: item.query.includes(':') ? 6 : 4,
        type: item.proxy ? 'Proxy/VPN' : (item.hosting ? 'Hosting' : 'Residential'),
        continent: item.continent,
        country: item.country,
        country_code: item.countryCode,
        region: item.regionName,
        city: item.city,
        latitude: item.lat,
        longitude: item.lon,
        is_eu: null,
        postal: item.zip,
        timezone: item.timezone,
        isp: item.isp,
        asn: asn,
        org: item.org,
        security: {
          vpn: item.proxy,
          proxy: item.proxy,
          tor: false,
          hosting: item.hosting,
          anonymous: item.proxy || item.hosting
        },
        privacy_status: item.proxy ? 'Proxy/VPN' : (item.hosting ? 'Hosting' : 'Clean'),
        raw: item
      }
    };
  });
}

function normalize_ip2location_data(data, ip, version) {
  const is_proxy = data.is_proxy || false;
  const proxy_type = data.proxy_type || '-';

  return {
    ip: data.ip || ip,
    version: version || (data.ip && data.ip.includes(':') ? 6 : 4),
    type: is_proxy ? 'Proxy/VPN' : 'Residential',
    continent: data.continent_name,
    country: data.country_name,
    country_code: data.country_code,
    region: data.region_name,
    city: data.city_name,
    latitude: data.latitude,
    longitude: data.longitude,
    is_eu: data.is_eu,
    postal: data.zip_code,
    timezone: data.time_zone,
    isp: (data.isp && data.isp !== '-') ? data.isp : (data.as || '-'),
    asn: data.asn,
    org: data.as,
    security: {
      vpn: proxy_type === 'VPN',
      proxy: is_proxy,
      tor: proxy_type === 'TOR',
      hosting: proxy_type === 'DCH',
      anonymous: is_proxy,
    },
    privacy_status: is_proxy ? (proxy_type || 'Proxy') : 'Clean',
    raw: data,
  };
}


function validate_ip(ipStr) {
  const v = net.isIP(String(ipStr || '').trim());
  if (v === 0) return { ok: false, version: null };
  return { ok: true, version: v };
}

function build_privacy_status(sec) {
  if (!sec || typeof sec !== 'object') return 'Unknown / Not available';
  if (sec.vpn) return 'VPN';
  if (sec.proxy) return 'Proxy';
  if (sec.tor) return 'Tor / Onion';
  if (sec.hosting) return 'Hosting / Datacenter';
  if (sec.anonymous) return 'Anonymous';
  return 'Residential / Clean';
}

async function fetch_ip_info(ip, version) {
  // Check cache first
  if (ipCache.has(ip)) {
    const cached = ipCache.get(ip);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }
    ipCache.delete(ip);
  }

  // RACE strategy for top 2 APIs + FALLBACK
  try {
    // Try FreeIPAPI and IPWHO.is in parallel (race to find the first success)
    const result = await Promise.any([
      fetch_freeipapi_info(ip),
      (async () => {
        const resp = await fetch(`https://ipwho.is/${ip}?security=1`, { signal: AbortSignal.timeout(4000) });
        const data = await resp.json();
        if (!data.success) throw new Error(data.message || 'ipwho.is failed');

        const sec = data.security || {};
        return {
          ip: data.ip,
          version: data.ip.includes(':') ? 6 : 4,
          type: data.type,
          continent: data.continent,
          country: data.country,
          country_code: data.country_code,
          region: data.region,
          city: data.city,
          latitude: data.latitude,
          longitude: data.longitude,
          is_eu: data.is_eu,
          postal: data.postal,
          timezone: data.timezone?.id,
          isp: data.connection?.isp,
          asn: data.connection?.asn,
          org: data.connection?.org,
          security: {
            vpn: Boolean(sec.vpn),
            proxy: Boolean(sec.proxy),
            tor: Boolean(sec.tor),
            hosting: Boolean(sec.hosting),
            anonymous: Boolean(sec.anonymous)
          },
          privacy_status: build_privacy_status(sec),
          raw: data
        };
      })()
    ]);

    ipCache.set(ip, { data: result, timestamp: Date.now() });
    return result;

  } catch (err) {
    console.warn(`Race APIs failed for ${ip}, falling back to IP2Location:`, err.message);

    // Final fallback to IP2Location
    try {
      const data = await fetch_ip2location_info(ip);
      const result = normalize_ip2location_data(data, ip, version);
      ipCache.set(ip, { data: result, timestamp: Date.now() });
      return result;
    } catch (finalErr) {
      console.error(`All lookup APIs failed for ${ip}:`, finalErr.message);
      throw new Error('All lookup APIs failed');
    }
  }
}

// â”€â”€â”€ AbuseIPDB Integration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const abuseCache = new Map();
const ABUSE_CACHE_TTL = 3600 * 1000; // 1 hour

// You can set your own key: set env var ABUSEIPDB_KEY=<your_key>
// Get a free key at https://www.abuseipdb.com/register
const ABUSEIPDB_KEY = process.env.ABUSEIPDB_KEY || '';

async function fetch_abuse_score(ip) {
  // If no key configured, return null to indicate missing key (so we don't return fake 'Clean' data)
  if (!ABUSEIPDB_KEY) {
    return null;
  }

  // Check abuse cache
  if (abuseCache.has(ip)) {
    const cached = abuseCache.get(ip);
    if (Date.now() - cached.timestamp < ABUSE_CACHE_TTL) return cached.data;
    abuseCache.delete(ip);
  }

  try {
    const url = `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90&verbose`;
    const resp = await fetch(url, {
      headers: {
        'Key': ABUSEIPDB_KEY,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(6000),
    });

    if (!resp.ok) return null;

    const json = await resp.json();
    const d = json.data || {};

    const result = {
      abuseScore: d.abuseConfidenceScore ?? 0,
      totalReports: d.totalReports ?? 0,
      lastReportedAt: d.lastReportedAt || null,
      usageType: d.usageType || null,
      isp: d.isp || null,
      domain: d.domain || null,
      isWhitelisted: Boolean(d.isWhitelisted),
      countryCode: d.countryCode || null,
    };

    abuseCache.set(ip, { data: result, timestamp: Date.now() });
    return result;
  } catch (e) {
    console.error(`AbuseIPDB lookup failed for ${ip}:`, e.message);
    return null;
  }
}

// POST /api/abuse-check  body: { ips: [ "1.2.3.4", ... ] }

async function fetch_bulk_ip_info(ips) {
  const apiUrl = 'http://ip-api.com/batch?fields=status,message,continent,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,mobile,proxy,hosting,query';

  const response = await fetch(apiUrl, {
    method: 'POST',
    body: JSON.stringify(ips.map(ip => ({ query: ip })))
  });

  if (!response.ok) {
    if (response.status === 429) throw new Error('API Rate limit exceeded. Please wait a minute.');
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();
  return data.map((item, idx) => {
    if (item.status === 'fail') {
      return { ip: ips[idx], ok: false, error: item.message };
    }

    const result = {
      ip: item.query,
      version: net.isIP(item.query),
      type: 'Residential', // Default
      continent: item.continent,
      country: item.country,
      country_code: item.countryCode,
      region: item.regionName,
      city: item.city,
      latitude: item.lat,
      longitude: item.lon,
      is_eu: false, // ip-api doesn't provide this directly in simple batch
      postal: item.zip,
      timezone: item.timezone,
      isp: item.isp,
      org: item.org,
      security: {
        vpn: Boolean(item.proxy),
        proxy: Boolean(item.proxy),
        tor: false, // mobile/proxy/hosting used for threat status
        hosting: Boolean(item.hosting),
        anonymous: Boolean(item.proxy || item.hosting)
      },
      privacy_status: item.proxy ? 'VPN/Proxy' : (item.hosting ? 'Hosting' : 'Clean'),
      raw: item
    };

    // Update cache
    ipCache.set(item.query, { data: result, timestamp: Date.now() });
    return { ip: item.query, ok: true, data: result };
  });
}

app.use(express.static(STATIC_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

app.post('/api/ip-bulk', async (req, res) => {
  try {
    const { ips } = req.body;
    if (!Array.isArray(ips) || !ips.length) {
      return res.status(400).json({ error: "No IPs provided" });
    }

    const cleaned = [...new Set(ips.map(x => String(x || '').trim()).filter(s => s && net.isIP(s)))];
    if (cleaned.length === 0) return res.status(400).json({ error: 'No valid IPs found' });

    const results = new Array(cleaned.length).fill(null);
    const toFetch = [];

    cleaned.forEach((ip, idx) => {
      const cached = ipCache.get(ip);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        results[idx] = { ip, ok: true, data: cached.data };
      } else {
        toFetch.push({ ip, idx });
      }
    });

    // HIGH SPEED BATCH: Use ip-api.com for bulk (100 per batch)
    const BATCH_SIZE = 100;
    const batchPromises = [];

    for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
      const chunk = toFetch.slice(i, i + BATCH_SIZE);
      batchPromises.push((async () => {
        try {
          const batchResults = await fetch_ipapi_batch(chunk.map(x => x.ip));
          batchResults.forEach((res, resIdx) => {
            const originalIdx = chunk[resIdx].idx;
            results[originalIdx] = res;
            if (res.ok) ipCache.set(res.ip, { data: res.data, timestamp: Date.now() });
          });
        } catch (err) {
          console.error('Batch chunk failure, falling back to individual:', err.message);
          // Fallback to individual optimized lookups for this chunk
          await Promise.all(chunk.map(async ({ ip, idx }) => {
            try {
              const data = await fetch_ip_info(ip, net.isIP(ip));
              results[idx] = { ip, ok: true, data };
            } catch (e) {
              results[idx] = { ip, ok: false, error: e.message };
            }
          }));
        }
      })());
    }

    await Promise.all(batchPromises);

    return res.json({ count: cleaned.length, results });
  } catch (err) {
    console.error('Bulk endpoint error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// â”€â”€â”€ ASN Lookup Integration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const asnCache = new Map();

app.get('/api/asn/:asn', async (req, res) => {
  const asn = req.params.asn;
  if (!asn) return res.status(400).json({ error: 'ASN required' });

  if (asnCache.has(asn)) return res.json(asnCache.get(asn));

  // TRY BGPView FIRST
  try {
    const resp = await fetch(`https://api.bgpview.io/asn/${asn}`, { signal: AbortSignal.timeout(4000) });
    if (resp.ok) {
      const data = await resp.json();
      const r = data.data;
      const result = {
        asn: r.asn,
        name: r.name,
        description: r.description_short,
        country: r.country_code,
        website: r.website,
        email: r.email_contacts?.[0],
        abuse: r.abuse_contacts?.[0],
        prefixes: r.prefixes_count || 0,
        peers: r.peers_count || 0,
        source: 'BGPView'
      };
      asnCache.set(asn, result);
      return res.json(result);
    }
  } catch (err) {
    console.log(`[ASN] BGPView unreachable for ${asn}, trying RIPEstat fallback...`);
  }

  // FALLBACK TO RIPEstat (Multi-point Aggregation)
  try {
    const urls = {
      overview: `https://stat.ripe.net/data/as-overview/data.json?resource=${asn}`,
      prefixes: `https://stat.ripe.net/data/announced-prefixes/data.json?resource=${asn}`,
      neighbours: `https://stat.ripe.net/data/asn-neighbours/data.json?resource=${asn}`,
      routing: `https://stat.ripe.net/data/routing-status/data.json?resource=${asn}`,
      whois: `https://stat.ripe.net/data/whois/data.json?resource=${asn}`,
      ixp: `https://stat.ripe.net/data/ixp-prefixes/data.json?resource=${asn}`
    };

    const timeout = 10000; // Increased to 10s for more points
    const entries = Object.entries(urls);
    const responses = await Promise.all(
      entries.map(([key, url]) =>
        fetch(url, { signal: AbortSignal.timeout(timeout) })
          .then(res => res.ok ? res.json() : null)
          .catch(() => null)
      )
    );

    const dataMap = {};
    entries.forEach(([key], idx) => { dataMap[key] = responses[idx]; });

    if (dataMap.overview && dataMap.overview.data) {
      const o = dataMap.overview.data;
      const p = dataMap.prefixes?.data?.prefixes || [];
      const n = dataMap.neighbours?.data?.neighbours || [];
      const r = dataMap.routing?.data || {};
      const w = dataMap.whois?.data?.records || [];
      const ix = dataMap.ixp?.data?.ixps || [];

      const holder = o.holder || '';
      const countryMatch = holder.match(/, ([A-Z]{2})$/);

      const result = {
        asn: asn,
        name: holder.replace(/, [A-Z]{2}$/, '').trim() || 'Unknown',
        country: countryMatch ? countryMatch[1] : null,
        prefixes: p.length,
        prefix_v4: p.filter(x => !x.prefix.includes(':')).length,
        prefix_v6: p.filter(x => x.prefix.includes(':')).length,
        peers: n.length,
        peers_v4: n.filter(x => x.type === 'left' || x.type === 'right').length,
        rpki: r.rpki_validation_status || 'unknown',
        announced: o.announced,
        whois: w.map(rec => rec.find(f => f.key === 'remarks' || f.key === 'descr')?.value || '').filter(Boolean).join('\n'), // Simplified WHOIS
        whois_full: w,
        ixp_count: ix.length,
        ixp_list: ix,
        source: 'RIPEstat (Police Grade)'
      };

      asnCache.set(asn, result);
      console.log(`[ASN] Fetched Tabbed-Intelligence for ${asn} from RIPEstat.`);
      return res.json(result);
    }
  } catch (err) {
    console.error(`[ASN] Enhanced RIPEstat failed for ${asn}:`, err.message);
  }

  return res.status(500).json({ error: 'All ASN lookup providers failed' });
});



// POST /api/abuse-check  body: { ips: ["1.2.3.4", ...] }
app.post('/api/abuse-check', async (req, res) => {
  try {
    const { ips } = req.body;
    if (!Array.isArray(ips) || !ips.length) {
      return res.status(400).json({ error: 'No IPs provided' });
    }


    const cleaned = ips.map(x => String(x || '').trim()).filter(s => net.isIP(s)).slice(0, 50);

    // Fetch all scores in parallel (each IP is a separate request)
    const scores = await Promise.all(cleaned.map(ip => fetch_abuse_score(ip)));

    const results = cleaned.map((ip, i) => ({ ip, abuse: scores[i] }));
    return res.json({ results });
  } catch (err) {
    console.error('abuse-check error:', err);
    return res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 5000;

// Bind host is configurable via HOST env var; default to localhost for
// development so the server doesn't expose 0.0.0.0 by default.
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`);
});

