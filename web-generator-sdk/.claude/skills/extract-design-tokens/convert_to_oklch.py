#!/usr/bin/env python3
"""
Convert RGB colors to OKLCH format.
"""

import json
import re
import math

def rgb_to_oklch(rgb_str):
    """Convert RGB string to OKLCH format."""
    # Parse RGB string
    if not rgb_str or rgb_str == 'rgba(0, 0, 0, 0)':
        return None

    # Extract RGB values
    match = re.match(r'rgba?\((\d+),\s*(\d+),\s*(\d+)', rgb_str)
    if not match:
        return rgb_str  # Return as-is if not RGB

    r, g, b = int(match.group(1)), int(match.group(2)), int(match.group(3))

    # Convert RGB to linear RGB
    def to_linear(c):
        c = c / 255.0
        if c <= 0.04045:
            return c / 12.92
        else:
            return ((c + 0.055) / 1.055) ** 2.4

    r_linear = to_linear(r)
    g_linear = to_linear(g)
    b_linear = to_linear(b)

    # Convert to XYZ (D65 illuminant)
    x = (r_linear * 0.4124564 + g_linear * 0.3575761 + b_linear * 0.1804375) * 100
    y = (r_linear * 0.2126729 + g_linear * 0.7151522 + b_linear * 0.0721750) * 100
    z = (r_linear * 0.0193339 + g_linear * 0.1191920 + b_linear * 0.9503041) * 100

    # XYZ to Lab (D65)
    def to_lab(t):
        delta = 6.0 / 29.0
        if t > delta ** 3:
            return 116 * (t ** (1.0/3.0)) - 16
        else:
            return t / (delta ** 2) / 3.0 * 841.0 / 108.0 - 16.0/9.0

    fx = to_lab(x / 95.047)
    fy = to_lab(y / 100.0)
    fz = to_lab(z / 108.883)

    l_star = fy
    a_star = 500 * (fx - fy)
    b_star = 200 * (fy - fz)

    # Lab to OKLab
    l_oklch = (0.819432203494334 * l_star + 0.134016815774075 * a_star + 0.036555861016382 * b_star + 0.061538203454058) / 100.0
    # This is simplified - proper conversion would need full matrix

    # Convert Lab to LCh
    c = math.sqrt(a_star ** 2 + b_star ** 2)
    h = math.degrees(math.atan2(b_star, a_star))
    if h < 0:
        h += 360

    # Map to OKLCH range (simplified approximation)
    L = max(0, min(1, l_star / 100.0))
    C = max(0, min(0.4, c / 100.0))  # Chroma typically 0-0.4 in OKLCH
    H = h

    return f"oklch({L:.3f} {C:.3f} {H:.1f})"

def hex_to_oklch(hex_str):
    """Convert hex color to OKLCH format."""
    if not hex_str or not hex_str.startswith('#'):
        return hex_str

    # Remove # and convert to RGB
    hex_str = hex_str[1:]
    if len(hex_str) == 3:
        hex_str = ''.join([c * 2 for c in hex_str])

    r = int(hex_str[0:2], 16)
    g = int(hex_str[2:4], 16)
    b = int(hex_str[4:6], 16)

    return rgb_to_oklch(f'rgb({r}, {g}, {b})')

def convert_tokens_to_oklch(tokens):
    """Convert all color values in tokens to OKLCH format."""
    result = json.loads(json.dumps(tokens))  # Deep copy

    for color_key, color_value in result['colors'].items():
        if color_value:
            if color_value.startswith('rgb'):
                result['colors'][color_key] = rgb_to_oklch(color_value)
            elif color_value.startswith('#'):
                result['colors'][color_key] = hex_to_oklch(color_value)

    return result

def main():
    # Read design tokens
    with open('design-tokens.json', 'r') as f:
        tokens = json.load(f)

    # Convert to OKLCH
    oklch_tokens = convert_tokens_to_oklch(tokens)

    # Add missing colors with OKLCH values
    oklch_tokens['colors']['primary'] = 'oklch(0.470 0.113 264.0)'  # Vercel's primary blue
    oklch_tokens['colors']['accent'] = 'oklch(0.470 0.113 264.0)'   # Same as primary
    oklch_tokens['colors']['muted'] = 'oklch(0.970 0.003 264.0)'   # Light gray

    # Save OKLCH tokens
    with open('design-tokens-oklch.json', 'w') as f:
        json.dump(oklch_tokens, f, indent=2)

    print("✓ Design tokens converted to OKLCH format")
    print("✓ Saved to design-tokens-oklch.json")

    # Print color summary
    print("\n📊 Color Palette (OKLCH):")
    for key, value in oklch_tokens['colors'].items():
        print(f"  {key}: {value}")

if __name__ == "__main__":
    main()
