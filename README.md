# X Creator Kit

Save the X Analytics days you care about, turn them into a receipt, or frame a screenshot for sharing. X Creator Kit is a free extension for desktop Chrome. Visit the [product website](https://xcreatorkit.com/) for examples.

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/x-creator-kit/pindijhdegpamfbgdaoaaahaljbombpe)** · [First read](#your-first-read) · [Build from source](#build-from-source) · [Contribute](CONTRIBUTING.md)

## Your first read

1. Install the extension and open [X Analytics](https://x.com/i/account_analytics) in your own account. Leave the verified-only filter off for your first read and wait for the chart to load.
2. With that tab active, open **X Creator Kit** from Chrome’s Extensions menu and choose **Read current X tab**. The popup reports how many days it saved.
3. Open **Analytics** to see those days. Read another date range to add to your history. **Ledger** uses those same all-viewer readings to make a summary card.

![The Read current X tab button in the extension popup](docs/images/read-annotated.webp)

The [illustrated walkthrough](https://xcreatorkit.com/guide/) covers setup and every tool.

## What you can do

| Tool | What it does |
| --- | --- |
| [Analytics](https://xcreatorkit.com/analytics/) | Save the days loaded in X Analytics, compare periods, and export a chart. Missing days stay blank. |
| [Ledger](https://xcreatorkit.com/ledger/) | Put a saved range on one summary card and download the PNG. |
| [Rewards pace](https://xcreatorkit.com/rewards-pace/) | Track X’s separate 90-day Verified Home Timeline impressions figure. A reading 2–10 UTC days before the latest one lets the kit calculate a straight-line pace. |
| [Receipts](https://xcreatorkit.com/receipts/) | Print a daily growth receipt, or make a [week or month recap](https://xcreatorkit.com/recaps/) from saved days. |
| [Post to image](https://xcreatorkit.com/post-to-image/) | Right-click a supported post, choose a look, and download it as an image. |
| [Screenshot editor](#frame-a-screenshot) | Crop and annotate a screenshot, frame it on a background, and save a PNG, JPEG or WebP locally. |
| [Follow-back check](https://xcreatorkit.com/follow-back/) | Highlight loaded rows on your own Following page using X’s “Follows you” badge. |

## Frame a screenshot

1. Open **Screenshot editor** in the toolbar, then drop, paste or choose a PNG, JPEG or WebP.
2. Choose **Crop** to drag the edges or enter exact pixels, then **Apply crop**.
3. The editor starts on a 1600 × 900 canvas and keeps its size when you replace a screenshot. In **Frame**, choose **Fit image** to follow the image dimensions, another preset, or an exact width and height. Select the screenshot to drag, resize or align it. Adjust the corners and padding, then choose a shadow preset or set its offset, blur, spread, opacity and colour.
4. In **Background**, choose an artwork, a gradient, a solid colour or your own image. Choose **Save this look** under **My styles** to reuse the settings on your next screenshot.
5. Add an arrow, text or a numbered step to explain a detail. Draw a **Box** and choose **Oval** in Layers to circle a detail. Use **Redact** to cover sensitive pixels. **Layers** lets you select a mark again.
6. Use the composition grid beside the zoom controls to line up the screenshot. Exports carry a small xcreatorkit.com credit in the lower-right corner. Use **Copy** to paste the finished image, or **Export…** to choose a file format, size and filename. Reloading or closing the editor clears the open image.

## Privacy

[Read the privacy policy for extension version 0.4.0](PRIVACY.md).

Readings stay in your browser. Dates use UTC, and the kit reads the current Analytics, Rewards, or profile page when you press **Read current X tab**. Post selection and Following highlights use optional X access.

Screenshot editing and export run offline. **My styles** saves the name you choose and the appearance settings in this browser, under the local storage key `xck-screenshot-styles`. The screenshot, uploaded background, filename, annotations and browser-frame address stay in memory while you edit.

## Build from source

Use Node.js 22 and npm. From a terminal:

```sh
git clone https://github.com/AaravKashyap12/xcreatorkit-extension.git
cd xcreatorkit-extension
npm ci
npm run build
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the generated `dist/` folder. After editing the source, rebuild and click **Reload** on the extension card.

## Find your way around

- [Extension screens](src/ui/), [screenshot editor](src/screenshot/), and [manifest and page HTML](static/)
- [Capture code](src/capture/), [local storage](src/store/), and [calculations](src/calc/)
- [Receipt renderer](src/receipt/), shared by the extension and PNG exports
- [test fixtures](test/fixtures/), and [browser verifiers](scripts/)
- [Contributor guide](CONTRIBUTING.md), [extension design rules](docs/v1/EXTENSION-READER.md), and [issue tracker](https://github.com/AaravKashyap12/xcreatorkit-extension/issues)

## License

X Creator Kit’s original code and documentation are available under the [MIT License](LICENSE). Fonts and third-party libraries retain their [respective licenses](THIRD_PARTY_NOTICES.md).
