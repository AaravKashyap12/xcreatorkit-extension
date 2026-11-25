# Extension UI

The toolbar puts **Read current X tab** first. The result appears beneath it so the user can see which source was read. Tools open from the chooser. The screenshot editor opens in its own tab.

Use the shared [design tokens](../../static/tokens.css) for task screens. The canvas is soft grey, panels are white, and controls use ink for text and selection. Blue identifies captured figures and their plotted lines. Give keyboard focus its own visible outline. Keep animated feedback usable when reduced motion is on.

Display dates in UTC. Show a dash for a missing reading. Preserve the artwork’s own type and colours in exported images. The [receipt renderer](../../src/receipt/) and [chart code](../../src/chart/) keep those decisions consistent between views.

Check changes with the [navigation verifier](../../scripts/verify-navigation.mjs) and [design verifier](../../scripts/verify-extension-design.mjs). For the user-facing steps, see the [setup guide](https://xcreatorkit.com/guide/).
