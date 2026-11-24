// The latest fastdl release, read from GitHub when the site is built, so the
// download buttons always point at real files. The site is rebuilt whenever a
// release is published (see .github/workflows/site.yml).

export const REPO = 'MahmoudSr/fastdl';
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
const LATEST_URL = `${RELEASES_URL}/latest`;

export interface Asset {
  url: string;
  size: string; // "1.8 MB"
}

export interface Release {
  version: string; // "0.2.1", or "" when GitHub could not be reached
  date: string; // "24 November 2026", or ""
  pageUrl: string;
  windows: Asset;
  portable: Asset;
  mac: Asset;
  crx: Asset;
  extensionZip: Asset;
}

// Asset names carry the version (fastdl_0.2.1_x64-setup.exe), so they are
// matched by their ending.
const PATTERNS = {
  windows: /_x64-setup\.exe$/,
  portable: /_x64-portable\.zip$/,
  mac: /\.dmg$/,
  crx: /^fastdl-extension\.crx$/,
  extensionZip: /^fastdl-extension\.zip$/,
} as const;

export function formatSize(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function fallback(): Release {
  // Without the API, every button still leads to the right page.
  const page: Asset = { url: LATEST_URL, size: '' };
  return {
    version: '',
    date: '',
    pageUrl: LATEST_URL,
    windows: page,
    portable: page,
    mac: page,
    crx: page,
    extensionZip: page,
  };
}

let cached: Promise<Release> | undefined;

export function getRelease(): Promise<Release> {
  cached ??= load();
  return cached;
}

async function load(): Promise<Release> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'fastdl-site-build',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  let data: {
    tag_name: string;
    html_url: string;
    published_at: string;
    assets: { name: string; browser_download_url: string; size: number }[];
  };
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.warn(`[release] Could not read the latest release, linking to the releases page instead: ${err}`);
    return fallback();
  }

  const release = fallback();
  release.version = data.tag_name.replace(/^v/, '');
  release.pageUrl = data.html_url;
  release.date = new Date(data.published_at).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  for (const [key, pattern] of Object.entries(PATTERNS) as [keyof typeof PATTERNS, RegExp][]) {
    const asset = data.assets.find((a) => pattern.test(a.name));
    if (asset) release[key] = { url: asset.browser_download_url, size: formatSize(asset.size) };
    else console.warn(`[release] ${data.tag_name} has no asset matching ${pattern}; linking to the release page.`);
  }
  return release;
}
