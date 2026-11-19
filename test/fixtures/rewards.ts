// SYNTHETIC fixtures — see README.md in this folder.
const nav = (handle: string | null) =>
  handle ? `<nav><a data-testid="AppTabBar_Profile_Link" href="/${handle}">Profile</a></nav>` : '<nav></nav>';

export const REWARDS_URL = 'https://x.com/i/jf/creators/original_content_rewards';

/** Requirement list with the current reading in a sibling element. */
export const rewardsRequirementRow = (value: string, handle: string | null = 'byaarav') => `
<body>${nav(handle)}<main>
  <h1>Original Content Rewards</h1>
  <p>You are not eligible yet</p>
  <ul>
    <li><div><span>At least 500 verified followers</span></div><div><span>750</span></div></li>
    <li>
      <div><span>At least 500K Verified Home Timeline impressions in the last 90 days</span>
           <span>Does not include replies</span></div>
      <div><span>${value}</span></div>
    </li>
  </ul>
</main></body>`;

/** Reading shown as "109.2K / 500K" inside one text node. */
export const rewardsPairText = `
<body>${nav('byaarav')}<main>
  <section><h2>Verified Home Timeline impressions</h2><p>109.2K / 500K</p><p>Last 90 days. Does not include replies.</p></section>
</main></body>`;

/** Accessible progressbar carrying an exact value. */
export const rewardsProgressbar = `
<body>${nav('byaarav')}<main>
  <section><h2>Verified Home Timeline impressions</h2><p>in the last 90 days</p>
  <div role="progressbar" aria-valuemin="0" aria-valuemax="500000" aria-valuenow="109214"></div><span>109.2K</span></section>
</main></body>`;

/** Two different numbers near the label: must refuse. */
export const rewardsAmbiguous = `
<body>${nav('byaarav')}<main>
  <div><span>Verified Home Timeline impressions (last 90 days)</span><span>109.2K</span><span>3.2K</span></div>
</main></body>`;

export const rewardsErrorPage = `<body>${nav('byaarav')}<main><p>Something went wrong. Try reloading.</p></main></body>`;

/** Account-overview content with impressions only: must NOT be read as rewards. */
export const accountOverviewOnly = `
<body>${nav('byaarav')}<main><div><span>Impressions</span><span>3.2K</span></div><div><span>Verified followers</span><span>750</span></div></main></body>`;
