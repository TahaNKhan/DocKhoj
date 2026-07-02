"""Render favicon.svg to PNGs at the sizes browsers ask for, and bundle a
multi-resolution .ico for legacy browsers / bookmarks.

Source-of-truth: web/public/favicon.svg
Outputs:
  web/public/favicon-16.png        tab favicon (small)
  web/public/favicon-32.png        tab favicon (HD)
  web/public/favicon-48.png        Windows site icon
  web/public/favicon.ico           16+32+48 packed (IE/old Edge/bookmarks)
  web/public/apple-touch-icon.png  180x180 (iOS home screen)
  web/public/icon-192.png          PWA manifest 192x192
  web/public/icon-512.png          PWA manifest 512x512
"""

from __future__ import annotations

import io
from pathlib import Path

import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "web" / "public"
SVG = PUBLIC / "favicon.svg"

SIZES = {
    "favicon-16.png": 16,
    "favicon-32.png": 32,
    "favicon-48.png": 48,
    "apple-touch-icon.png": 180,
    "icon-192.png": 192,
    "icon-512.png": 512,
}


def render_png(raster_size: int) -> bytes:
    """Rasterize the SVG at a target pixel size, preserving aspect ratio."""
    return cairosvg.svg2png(
        url=str(SVG),
        output_width=raster_size,
        output_height=raster_size,
    )


def main() -> None:
    PNG_CACHE: dict[int, bytes] = {}

    def png(size: int) -> bytes:
        if size not in PNG_CACHE:
            PNG_CACHE[size] = render_png(size)
        return PNG_CACHE[size]

    PUBLIC.mkdir(parents=True, exist_ok=True)

    for filename, size in SIZES.items():
        out = PUBLIC / filename
        out.write_bytes(png(size))
        print(f"wrote {out.relative_to(ROOT)} ({size}x{size})")

    # Pack 16+32+48 into a single .ico — older browsers and the OS
    # bookmark/favicon picker use the highest-density frame they can show.
    ico_frames = [Image.open(io.BytesIO(png(s))) for s in (16, 32, 48)]
    ico_path = PUBLIC / "favicon.ico"
    ico_frames[0].save(
        ico_path,
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
        append_images=ico_frames[1:],
    )
    print(f"wrote {ico_path.relative_to(ROOT)} (16+32+48)")


if __name__ == "__main__":
    main()
