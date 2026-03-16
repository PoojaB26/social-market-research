#!/usr/bin/env python3
"""
Generate PNG icons for the Tweet Market Intel Chrome extension.

Matches the design in icons/icon48.svg and icons/icon128.svg:
  - Dark rounded rect background (#0d0d0f)
  - 4 green bars (#00e5a0) increasing in height with decreasing opacity

Tries multiple approaches in order:
  1. Pillow (PIL) - best quality
  2. cairosvg - converts SVG directly
  3. Pure Python (struct/zlib) - no dependencies needed

Usage:
    python3 generate_icons.py
"""

import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ICONS_DIR = os.path.join(SCRIPT_DIR, 'icons')


def try_pillow():
    """Generate PNGs using Pillow (PIL) with antialiased drawing."""
    from PIL import Image, ImageDraw

    def generate(size):
        if size == 48:
            bg_rx = 10
            bars = [(8, 28, 6, 12, 2, 1.0), (17, 22, 6, 18, 2, 0.8),
                    (26, 16, 6, 24, 2, 0.6), (35, 10, 6, 30, 2, 0.4)]
        else:
            bg_rx = 24
            bars = [(18, 72, 18, 38, 4, 1.0), (42, 56, 18, 54, 4, 0.8),
                    (66, 38, 18, 72, 4, 0.6), (90, 22, 18, 88, 4, 0.4)]

        img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)

        # Background
        draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=bg_rx,
                               fill=(0x0d, 0x0d, 0x0f, 255))

        # Bars - draw each on a separate layer for proper alpha compositing
        for (bx, by, bw, bh, brx, opacity) in bars:
            bar_layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
            bar_draw = ImageDraw.Draw(bar_layer)
            alpha = int(opacity * 255)
            bar_draw.rounded_rectangle([bx, by, bx + bw - 1, by + bh - 1],
                                       radius=brx,
                                       fill=(0x00, 0xe5, 0xa0, alpha))
            img = Image.alpha_composite(img, bar_layer)

        path = os.path.join(ICONS_DIR, f'icon{size}.png')
        img.save(path, 'PNG')
        print(f'Created {path} (Pillow)')

    generate(48)
    generate(128)
    return True


def try_cairosvg():
    """Convert SVG files directly to PNG using cairosvg."""
    import cairosvg

    for size in (48, 128):
        svg_path = os.path.join(ICONS_DIR, f'icon{size}.svg')
        png_path = os.path.join(ICONS_DIR, f'icon{size}.png')
        cairosvg.svg2png(url=svg_path, write_to=png_path,
                         output_width=size, output_height=size)
        print(f'Created {png_path} (cairosvg)')

    return True


def try_pure_python():
    """Generate PNGs using only Python standard library (struct + zlib)."""
    import struct
    import zlib

    def create_png(width, height, pixels):
        """Create a minimal valid PNG file from RGBA pixel data."""
        def chunk(chunk_type, data):
            c = chunk_type + data
            crc = struct.pack('>I', zlib.crc32(c) & 0xffffffff)
            return struct.pack('>I', len(data)) + c + crc

        signature = b'\x89PNG\r\n\x1a\n'
        ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
        ihdr = chunk(b'IHDR', ihdr_data)

        raw_data = bytearray()
        for y in range(height):
            raw_data.append(0)  # filter byte (none)
            for x in range(width):
                idx = (y * width + x) * 4
                raw_data.extend(pixels[idx:idx + 4])

        compressed = zlib.compress(bytes(raw_data), 9)
        idat = chunk(b'IDAT', compressed)
        iend = chunk(b'IEND', b'')

        return signature + ihdr + idat + iend

    def draw_rounded_rect(pixels, width, height, x, y, w, h, rx, r, g, b, a=255):
        """Draw a rounded rectangle with alpha compositing."""
        for py in range(max(0, y), min(y + h, height)):
            for px in range(max(0, x), min(x + w, width)):
                lx = px - x
                ly = py - y

                inside = True
                if lx < rx and ly < rx:
                    dx = rx - lx - 1
                    dy = rx - ly - 1
                    if dx * dx + dy * dy > rx * rx:
                        inside = False
                elif lx >= w - rx and ly < rx:
                    dx = lx - (w - rx)
                    dy = rx - ly - 1
                    if dx * dx + dy * dy > rx * rx:
                        inside = False
                elif lx < rx and ly >= h - rx:
                    dx = rx - lx - 1
                    dy = ly - (h - rx)
                    if dx * dx + dy * dy > rx * rx:
                        inside = False
                elif lx >= w - rx and ly >= h - rx:
                    dx = lx - (w - rx)
                    dy = ly - (h - rx)
                    if dx * dx + dy * dy > rx * rx:
                        inside = False

                if inside:
                    idx = (py * width + px) * 4
                    src_a = a / 255.0
                    dst_r, dst_g, dst_b = pixels[idx], pixels[idx + 1], pixels[idx + 2]
                    dst_a = pixels[idx + 3] / 255.0

                    out_a = src_a + dst_a * (1 - src_a)
                    if out_a > 0:
                        out_r = int((r * src_a + dst_r * dst_a * (1 - src_a)) / out_a)
                        out_g = int((g * src_a + dst_g * dst_a * (1 - src_a)) / out_a)
                        out_b = int((b * src_a + dst_b * dst_a * (1 - src_a)) / out_a)
                    else:
                        out_r = out_g = out_b = 0

                    pixels[idx] = min(255, max(0, out_r))
                    pixels[idx + 1] = min(255, max(0, out_g))
                    pixels[idx + 2] = min(255, max(0, out_b))
                    pixels[idx + 3] = min(255, max(0, int(out_a * 255)))

    def generate(size):
        pixels = [0] * (size * size * 4)
        bg_r, bg_g, bg_b = 0x0d, 0x0d, 0x0f
        bar_r, bar_g, bar_b = 0x00, 0xe5, 0xa0

        if size == 48:
            bg_rx = 10
            bars = [(8, 28, 6, 12, 2, 1.0), (17, 22, 6, 18, 2, 0.8),
                    (26, 16, 6, 24, 2, 0.6), (35, 10, 6, 30, 2, 0.4)]
        else:
            bg_rx = 24
            bars = [(18, 72, 18, 38, 4, 1.0), (42, 56, 18, 54, 4, 0.8),
                    (66, 38, 18, 72, 4, 0.6), (90, 22, 18, 88, 4, 0.4)]

        draw_rounded_rect(pixels, size, size, 0, 0, size, size, bg_rx,
                          bg_r, bg_g, bg_b, 255)

        for (bx, by, bw, bh, brx, opacity) in bars:
            alpha = int(opacity * 255)
            draw_rounded_rect(pixels, size, size, bx, by, bw, bh, brx,
                              bar_r, bar_g, bar_b, alpha)

        png_data = create_png(size, size, pixels)
        path = os.path.join(ICONS_DIR, f'icon{size}.png')
        with open(path, 'wb') as f:
            f.write(png_data)
        print(f'Created {path} ({len(png_data)} bytes, pure Python)')

    generate(48)
    generate(128)
    return True


def main():
    os.makedirs(ICONS_DIR, exist_ok=True)

    # Try each approach in order of quality
    approaches = [
        ('Pillow', try_pillow),
        ('cairosvg', try_cairosvg),
        ('pure Python', try_pure_python),
    ]

    for name, func in approaches:
        try:
            print(f'Trying {name}...')
            if func():
                print(f'Success with {name}!')
                return 0
        except ImportError:
            print(f'{name} not available, trying next...')
        except Exception as e:
            print(f'{name} failed: {e}, trying next...')

    print('ERROR: All approaches failed.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
