#!/usr/bin/env python3
"""OZ Browser — generate build/icon.icns from the OZ brand assets.

Composites the LOGOOZ RED TRANS logo over a beige background with
macOS-style squircle corners, scales the result to all 10 required
.iconset sizes, then runs `iconutil` to produce build/icon.icns.

Brand colors (project memory):
  Terracota OZ = #B85B3D  (matches the LOGOOZ RED PNG fill)
  Beige OZ     = #D2BD9C
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
LOGO = Path(
    "/Users/joserodrigocoronel/Library/CloudStorage/Dropbox/"
    "Agencia OZ/LOGOS y Branding/Agencia/LOGOOZ RED TRANS.png"
)
BUILD = REPO / "build"
ICONSET = BUILD / "icon.iconset"
OUT_ICNS = BUILD / "icon.icns"
TMP_PNG = BUILD / "icon-1024.png"

BG = (0xD2, 0xBD, 0x9C, 255)  # beige
SIZE = 1024
LOGO_FRAC = 0.62  # logo occupies ~62% of canvas (gives padding for squircle)
RADIUS_FRAC = 0.225  # macOS Big Sur+ squircle ≈ 22.5% of canvas

if not LOGO.exists():
    print(f"ERROR: logo not found at {LOGO}", file=sys.stderr)
    sys.exit(1)

print(f"Reading logo: {LOGO}")
logo = Image.open(LOGO).convert("RGBA")

# Build the 1024×1024 canvas with squircle background.
canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
mask = Image.new("L", (SIZE, SIZE), 0)
draw = ImageDraw.Draw(mask)
r = int(SIZE * RADIUS_FRAC)
draw.rounded_rectangle((0, 0, SIZE, SIZE), radius=r, fill=255)

bg = Image.new("RGBA", (SIZE, SIZE), BG)
canvas.paste(bg, (0, 0), mask)

# Resize logo into LOGO_FRAC of canvas, center it.
target = int(SIZE * LOGO_FRAC)
ratio = min(target / logo.width, target / logo.height)
new_w = int(logo.width * ratio)
new_h = int(logo.height * ratio)
logo_resized = logo.resize((new_w, new_h), Image.Resampling.LANCZOS)

# Center horizontally + vertically. The OZ glyph in the source PNG is
# vertically centered already so a straight middle paste works.
x = (SIZE - new_w) // 2
y = (SIZE - new_h) // 2
canvas.paste(logo_resized, (x, y), logo_resized)

BUILD.mkdir(parents=True, exist_ok=True)
canvas.save(TMP_PNG, "PNG")
print(f"Wrote 1024×1024 base: {TMP_PNG}")

# Generate all 10 .iconset sizes via PIL (avoids relying on `sips`).
if ICONSET.exists():
    shutil.rmtree(ICONSET)
ICONSET.mkdir()

specs = [
    (16, "icon_16x16.png"),
    (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"),
    (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"),
    (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"),
    (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"),
    (1024, "icon_512x512@2x.png"),
]
for size, name in specs:
    img = canvas.resize((size, size), Image.Resampling.LANCZOS)
    img.save(ICONSET / name, "PNG")
print(f"Wrote {len(specs)} sizes to {ICONSET}")

# Run iconutil to package into .icns
print(f"Running iconutil → {OUT_ICNS}")
subprocess.run(
    ["iconutil", "-c", "icns", str(ICONSET), "-o", str(OUT_ICNS)],
    check=True,
)
print(f"Done. {OUT_ICNS} ({OUT_ICNS.stat().st_size:,} bytes)")
