#!/usr/bin/env python3
"""
Extract design tokens from a reference website using Playwright.
Outputs structured JSON with colors, typography, spacing, borders, and shadows.
"""

import asyncio
import json
import re
from playwright.async_api import async_playwright

async def extract_design_tokens(url):
    """Extract design tokens from the given URL."""
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.goto(url, wait_until="networkidle")
        await page.wait_for_timeout(2000)  # Wait for any animations

        # Extract design tokens using JavaScript
        tokens = await page.evaluate("""
() => {
    const tokens = {
        colors: {},
        typography: {
            fontFamily: {},
            fontSize: {},
            fontWeight: {}
        },
        spacing: {},
        borderRadius: {},
        shadows: {}
    };

    // Helper to get computed style
    const getStyle = (selector, prop) => {
        const el = document.querySelector(selector);
        return el ? getComputedStyle(el)[prop] : null;
    };

    const getBodyStyle = (prop) => getComputedStyle(document.body)[prop];

    // Extract colors from key elements
    const colors = {
        // Background colors
        background: getBodyStyle('backgroundColor'),
        card: getStyle('[class*="card"], [class*="Card"]', 'backgroundColor') ||
               getStyle('div[class*="bg-"]', 'backgroundColor'),

        // Foreground colors
        foreground: getBodyStyle('color'),
        cardForeground: getStyle('h1, h2, h3', 'color') || getBodyStyle('color'),

        // Primary colors (from buttons/CTAs)
        primary: getStyle('button[class*="primary"], button:not([class*="secondary"]):not([class*="ghost"])', 'backgroundColor') ||
                 getStyle('a[class*="button"], a[class*="btn"]', 'backgroundColor') ||
                 getStyle('button', 'backgroundColor'),
        primaryForeground: getStyle('button[class*="primary"], button:not([class*="secondary"]):not([class*="ghost"])', 'color') ||
                           getStyle('button', 'color'),

        // Secondary colors
        secondary: getStyle('button[class*="secondary"]', 'backgroundColor') ||
                   getStyle('a[class*="secondary"]', 'backgroundColor'),
        secondaryForeground: getStyle('button[class*="secondary"]', 'color'),

        // Accent colors
        accent: getStyle('[class*="accent"]', 'backgroundColor') ||
                getStyle('button[class*="primary"]', 'backgroundColor'),

        // Muted colors
        muted: getStyle('[class*="muted"], [class*="gray"]', 'backgroundColor') ||
               getStyle('div[class*="bg-gray"]', 'backgroundColor') ||
               '#f1f5f9',
        mutedForeground: getStyle('[class*="muted"]', 'color') ||
                         getStyle('p, span', 'color') ||
                         '#64748b',

        // Border colors
        border: getStyle('[class*="border"]', 'borderColor') ||
                getStyle('input, button', 'borderColor') ||
                '#e2e8f0',
        input: getStyle('input', 'borderColor') ||
               getStyle('input', 'backgroundColor') ||
               '#e2e8f0',

        // Ring/focus colors
        ring: getStyle('*:focus-visible', 'outlineColor') ||
              '#3b82f6',

        // Destructive colors (error states)
        destructive: getStyle('[class*="error"], [class*="danger"]', 'backgroundColor') ||
                     getStyle('[class*="red"]', 'color') ||
                     '#ef4444',
        destructiveForeground: '#ffffff',

        // Popover colors
        popover: getStyle('[class*="popover"], [role="tooltip"]', 'backgroundColor') ||
                 '#ffffff',
        popoverForeground: getStyle('[class*="popover"], [role="tooltip"]', 'color') ||
                           '#0f172a'
    };

    tokens.colors = colors;

    // Extract typography
    const fontFamily = getBodyStyle('fontFamily');
    tokens.typography.fontFamily = {
        sans: fontFamily || 'Inter, system-ui, sans-serif',
        mono: getStyle('code, pre, [class*="mono"]', 'fontFamily') || 'Fira Code, monospace'
    };

    // Extract font sizes from headings
    const headingSizes = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
    headingSizes.forEach((tag, i) => {
        const size = getStyle(tag, 'fontSize');
        if (size) {
            tokens.typography.fontSize[`${i === 0 ? '4xl' : i === 1 ? '3xl' : i === 2 ? '2xl' : i === 3 ? 'xl' : i === 4 ? 'lg' : 'base'}`] = size;
        }
    });

    // Add standard font sizes
    tokens.typography.fontSize = {
        xs: '0.75rem',
        sm: '0.875rem',
        base: getStyle('p, span', 'fontSize') || '1rem',
        lg: getStyle('h6', 'fontSize') || '1.125rem',
        xl: getStyle('h5', 'fontSize') || '1.25rem',
        '2xl': getStyle('h4', 'fontSize') || '1.5rem',
        '3xl': getStyle('h3', 'fontSize') || '1.875rem',
        '4xl': getStyle('h1', 'fontSize') || '2.25rem',
        ...tokens.typography.fontSize
    };

    // Extract font weights
    tokens.typography.fontWeight = {
        normal: getStyle('body, p', 'fontWeight') || 400,
        medium: getStyle('button, h5', 'fontWeight') || 500,
        semibold: getStyle('h3, h4, strong', 'fontWeight') || 600,
        bold: getStyle('h1, h2', 'fontWeight') || 700
    };

    // Extract spacing from common elements
    const spacingElements = ['button', 'input', 'div[class*="p-"]', 'div[class*="gap-"]'];
    const spacingValues = new Set();
    spacingElements.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
            const style = getComputedStyle(el);
            spacingValues.add(style.paddingTop);
            spacingValues.add(style.paddingBottom);
            spacingValues.add(style.paddingLeft);
            spacingValues.add(style.paddingRight);
            spacingValues.add(style.marginTop);
            spacingValues.add(style.marginBottom);
            spacingValues.add(style.gap);
        });
    });

    // Cluster spacing values
    const sortedSpacing = Array.from(spacingValues)
        .filter(v => v && v !== '0px')
        .map(v => parseFloat(v))
        .sort((a, b) => a - b);

    if (sortedSpacing.length > 0) {
        tokens.spacing = {
            xs: '0.25rem',
            sm: '0.5rem',
            md: sortedSpacing[Math.floor(sortedSpacing.length * 0.3)] + 'px' || '1rem',
            lg: sortedSpacing[Math.floor(sortedSpacing.length * 0.5)] + 'px' || '1.5rem',
            xl: sortedSpacing[Math.floor(sortedSpacing.length * 0.7)] + 'px' || '2rem',
            '2xl': sortedSpacing[Math.floor(sortedSpacing.length * 0.9)] + 'px' || '3rem'
        };
    } else {
        tokens.spacing = {
            xs: '0.25rem',
            sm: '0.5rem',
            md: '1rem',
            lg: '1.5rem',
            xl: '2rem',
            '2xl': '3rem'
        };
    }

    // Extract border radius
    const radiusElements = ['button', 'input', '[class*="card"]', '[class*="rounded"]'];
    const radiusValues = new Set();
    radiusElements.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
            const radius = getComputedStyle(el).borderRadius;
            if (radius && radius !== '0px') {
                radiusValues.add(radius);
            }
        });
    });

    const sortedRadius = Array.from(radiusValues).sort();
    tokens.borderRadius = {
        sm: sortedRadius[0] || '0.25rem',
        md: sortedRadius[Math.floor(sortedRadius.length * 0.25)] || '0.375rem',
        lg: sortedRadius[Math.floor(sortedRadius.length * 0.5)] || '0.5rem',
        xl: sortedRadius[Math.floor(sortedRadius.length * 0.75)] || '0.75rem',
        full: sortedRadius[sortedRadius.length - 1] || '9999px'
    };

    // Extract shadows
    const shadowElements = ['button', '[class*="shadow"]', '[class*="card"]', '[role="dialog"]'];
    const shadowValues = new Set();
    shadowElements.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
            const shadow = getComputedStyle(el).boxShadow;
            if (shadow && shadow !== 'none') {
                shadowValues.add(shadow);
            }
        });
    });

    const sortedShadows = Array.from(shadowValues);
    tokens.shadows = {
        sm: sortedShadows[0] || '0 1px 2px rgb(0 0 0 / 0.05)',
        md: sortedShadows[Math.floor(sortedShadows.length * 0.33)] || '0 4px 6px -1px rgb(0 0 0 / 0.1)',
        lg: sortedShadows[Math.floor(sortedShadows.length * 0.66)] || '0 10px 15px -3px rgb(0 0 0 / 0.1)',
        xl: sortedShadows[sortedShadows.length - 1] || '0 20px 25px -5px rgb(0 0 0 / 0.1)'
    };

    return tokens;
}
""")

        await browser.close()
        return tokens

def convert_to_oklch(color_str):
    """Convert CSS color to OKLCH format (simplified - returns original for now)."""
    if not color_str or color_str == 'rgba(0, 0, 0, 0)':
        return None

    # For now, return the color as-is (OKLCH conversion can be done with a library)
    # This is a placeholder - in production, use colorsys or similar
    return color_str

def process_tokens(tokens):
    """Process and clean up the extracted tokens."""
    # Process colors
    colors = {}
    for key, value in tokens['colors'].items():
        if value and value != 'rgba(0, 0, 0, 0)':
            colors[key] = value
        elif key == 'background':
            colors[key] = '#ffffff'
        elif key == 'foreground':
            colors[key] = '#0f172a'

    tokens['colors'] = colors
    return tokens

async def main():
    url = "https://vercel.com"
    print(f"Extracting design tokens from {url}...")

    tokens = await extract_design_tokens(url)
    tokens = process_tokens(tokens)

    # Save to file
    output_file = "design-tokens.json"
    with open(output_file, 'w') as f:
        json.dump(tokens, f, indent=2)

    print(f"✓ Design tokens saved to {output_file}")
    print(f"  - {len(tokens['colors'])} colors extracted")
    print(f"  - {len(tokens['typography']['fontFamily'])} font families")
    print(f"  - {len(tokens['typography']['fontSize'])} font sizes")
    print(f"  - {len(tokens['typography']['fontWeight'])} font weights")
    print(f"  - {len(tokens['spacing'])} spacing values")
    print(f"  - {len(tokens['borderRadius'])} border radius values")
    print(f"  - {len(tokens['shadows'])} shadow values")

    return tokens

if __name__ == "__main__":
    asyncio.run(main())
