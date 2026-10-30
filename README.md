# InstaGraph

A standalone Instagram GraphQL response extractor. Open `index.html` in a modern browser, paste a response or load a `.json` file, then choose **Extract data**.

## Downloads

- **Save file** downloads one attachment asset at a time, using the highest-quality available variant.
- **Download media** fetches and saves all media assets sequentially as separate files, including available video thumbnails. It does not put these files into an archive. The browser may ask you to allow multiple downloads.
- **Complete package (.zip)** creates one archive with the selected highest-quality media in the ZIP root, alternate qualities in `qualities/`, and text/JSON files under `metadata/`.
- Mentions and tagged accounts link to their Instagram profiles in the on-page preview.
- Mentions are collected from caption text, `tappable_objects`, story `story_bloks_stickers`, and structured tagged-account data.
- Story `story_feed_media` references with `product_type: clips` are linked using their shortcode. If the response contains video and image variants, those assets are added to the downloads and package.

Media timestamps are converted to IST (`Asia/Kolkata`) before naming, and filenames follow the requested type labels:

- Story image: `2026-08-12_14-00-00_@ritesh_12@_story-img.jpg`
- Story video and thumbnail only: `2026-08-12_14-00-00_@ritesh_12@_story-vid.mp4` and `2026-08-12_14-00-00_@ritesh_12@_story-thb.jpg` (`story-img` is reserved for image-only stories)
- Reel video and thumbnail: `2026-08-12_14-00-00_@ritesh_12@_reel-vid.mp4` and `2026-08-12_14-00-00_@ritesh_12@_reel-thb.jpg`
- Post item 1 image/video/thumbnail: `2026-08-12_14-00-00_@ritesh_12@_post-img-1.jpg`, `2026-08-12_14-00-00_@ritesh_12@_post-vid-1.mp4`, and `2026-08-12_14-00-00_@ritesh_12@_post-thb-1.jpg`

Post item numbering starts at 1 and follows the order of items in the post. Story and reel filenames do not include an item number. A story image without a direct timestamp uses the time estimated from its expiry when available.

The categorized report and package are named `2026-08-12_@ritesh_12@categorized-report.txt` and `2026-08-12_@ritesh_12@package.zip`. In the package, selected media files sit in the ZIP root, alternate media qualities are under `qualities/`, and text/JSON files are inside `metadata/`.

The categorized report groups media files beneath each post, story, or reel item. A video item keeps its video and thumbnail together in that item section. It includes additional Instagram fields such as audio, story stickers, AI labels, carousel data, partnership/sponsor details, sharing friction, viewer state, and boost/reply status when present.

The page does not send the JSON anywhere. Media downloads are requested directly from the source URLs in the response. Some Instagram CDNs block cross-origin downloads; blocked media is listed with its source URL in the complete package and can be opened individually in a new tab to save manually.

Instagram GraphQL response formats vary. Fields are only available when included in the supplied response. The on-page checklist describes additional fields the extractor can report when present.

