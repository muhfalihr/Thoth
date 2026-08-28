# Platform logo references

Reference crops of the social-platform logos/watermarks that appear burned into reposted clips.
`scripts/vision/embed_platform_logos.py seed` reads this folder, embeds every image, and writes the
`platform_logos` table in Supabase. Scout then queries that table at trace time — nothing here is
read by the pipeline directly.

## Layout

```
assets/platform_logos/
  tiktok/      glyph-white.png  watermark-username.png  wordmark-dark.png
  instagram/   camera-gradient.png  reels-badge.png
  twitter/     x-black.png  bird-blue.png
  youtube/     play-red.png  shorts-badge.png
  facebook/    f-circle.png
  threads/     at-hook.png
```

Folder name = platform id, and it must be one of the ids in the script's `CATALOG`
(`tiktok`, `instagram`, `twitter`, `youtube`, `facebook`, `threads`). Anything else is skipped with a
warning. The file stem becomes the variant label; use something descriptive, since that label is what
the grouping report names when a reference looks wrong.

Accepted suffixes: `.png`, `.jpg`, `.jpeg`, `.webp`. Transparent PNGs are flattened onto white.

## Choosing references

Crops taken from **real posts** beat press-kit artwork — a watermark as it actually renders (small,
semi-transparent, over busy footage) is what the model will meet at runtime. Two or three variants
per platform is plenty; the seeder reports how tightly they cluster, and a variant far from its own
group is a signal that the crop caught background instead of the logo.

The seeder also warns when two platforms' logo groups sit closer than 0.9 cosine — that pair will be
a coin flip at match time, so drop or re-crop one of them.

## Re-seeding

Re-run after any change here:

```
python scripts/vision/embed_platform_logos.py seed
python scripts/vision/embed_platform_logos.py report   # read the table back
```

Rows are keyed by `(platform, variant)`, so re-seeding updates in place. Deleting a file here does
NOT delete its row — remove those by hand if a reference is retired.
