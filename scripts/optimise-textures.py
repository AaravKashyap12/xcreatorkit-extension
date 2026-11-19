"""Turns the raw Chromium bakes (studio/textures/*.png, from scripts/bake-textures.mjs) into the small
greyscale JPEGs the receipt module inlines (src/receipt/textures/*.jpg).
    python scripts/optimise-textures.py
"""
from pathlib import Path
from PIL import Image

src, out = Path('studio/textures'), Path('src/receipt/textures')
out.mkdir(parents=True, exist_ok=True)

# Crumpled paper: multiply layer, greyscale, 900x1350 covers the 1080x1350 artboard when stretched.
Image.open(src / 'crumple.png').convert('L').resize((900, 1350), Image.LANCZOS).save(out / 'crumple.jpg', quality=80)
# Grain: tiles at 400px.
Image.open(src / 'grain.png').convert('L').crop((0, 0, 400, 400)).save(out / 'grain.jpg', quality=72)
# Grunge: alpha channel to luminance (white = ink, black = gap), used with mask-mode: luminance.
Image.open(src / 'grunge.png').split()[3].crop((0, 0, 400, 400)).save(out / 'grunge.jpg', quality=82)

for f in sorted(out.iterdir()):
    print(f.name, f.stat().st_size // 1024, 'KB')
