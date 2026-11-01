# Draws the 国策档案 cover as one self-contained SVG (2:3, 1200 x 1800).
# All text becomes outlines from Source Han Serif CN (SIL OFL), so the SVG needs no installed font.
# Usage: python docs/cover/build-cover.py docs/cover/国策档案-封面.svg
# PNG at 2x: msedge --headless=new --hide-scrollbars --force-device-scale-factor=2 --window-size=1200,1800
#   --screenshot=<out.png> file:///<path to the svg>
import math
import os
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONTS = os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Windows\Fonts")
HEAVY = TTFont(os.path.join(FONTS, "思源宋体 CN Heavy.otf"))
SEMI = TTFont(os.path.join(FONTS, "思源宋体 CN SemiBold.otf"))

W, H, CX = 1200, 1800, 600
# Same tokens as src/style.css.
INK, BG, PANEL = "#0d1310", "#131a16", "#19221d"
GOLD, GOLD_DEEP = "#dcc27c", "#a88d4c"
TEXT, MUTED, FAINT = "#ece6d4", "#a8b0a1", "#7d867a"
AMBER, SEAL, SEAL_INK = "#e6a950", "#b4432f", "#f3dccb"

# Same 64 x 64 stroke icons as src/icons.ts.
ICONS = {
    "crown": '<path d="M10 18l10 9 12-17 12 17 10-9-6 29H16z"/><path d="M16 53h32M21 38h22"/>',
    "industry": '<path d="M10 53V28l15 8V24l14 8V11h9l3 42z"/><path d="M17 43h5m8 0h5m8 0h3"/>',
    "army": '<path d="M15 10l39 39-5 5L10 15zM49 10L10 49l5 5 39-39zM7 40l17 17m16-50 17 17"/>',
    "science": '<path d="M24 9h16M28 9v21L14 49q-3 6 4 6h28q7 0 4-6L36 30V9M23 40h18"/><circle cx="32" cy="46" r="2"/>',
    "trade": '<path d="M10 25h44L44 13m10 12L44 37M54 43H10l10-12M10 43l10 12"/>',
    "diplomacy": '<circle cx="32" cy="32" r="22"/><ellipse cx="32" cy="32" rx="10" ry="22"/><path d="M10 32h44M15 19h34M15 45h34"/>',
    "eagle": '<path d="M32 15l-7-6-4 3 6 9-9-4L6 8l3 20 14 10-9 7 12-2 6 14 6-14 12 2-9-7 14-10 3-20-12 9-9 4 6-9-4-3z"/><path d="M27 28l5 13 5-13"/>',
}


def num(v):
    return ("%.1f" % v).rstrip("0").rstrip(".")


def glyph(font, ch, x, baseline, size):
    """Returns the outline of one character and its advance width."""
    glyphs = font.getGlyphSet()
    name = font.getBestCmap()[ord(ch)]
    scale = size / font["head"].unitsPerEm
    pen = SVGPathPen(glyphs, ntos=num)
    glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
    commands = pen.getCommands()
    return (f'<path d="{commands}"/>' if commands else ""), glyphs[name].width * scale


def advance(font, ch, size):
    return font.getGlyphSet()[font.getBestCmap()[ord(ch)]].width * size / font["head"].unitsPerEm


def line(font, text, cx, baseline, size, tracking=0.0):
    """Centres a single line on cx; tracking is a fraction of the size."""
    gap = tracking * size
    width = sum(advance(font, ch, size) for ch in text) + gap * (len(text) - 1)
    x, parts = cx - width / 2, []
    for ch in text:
        path, step = glyph(font, ch, x, baseline, size)
        parts.append(path)
        x += step + gap
    return "".join(parts)


def ideograph(font, ch, cx, cy, size):
    """Centres one ideograph on its em box (-120 to 880 in Source Han Serif)."""
    return glyph(font, ch, cx - size / 2, cy + 0.38 * size, size)[0]


def node(cx, cy, r, icon, state, progress=0.0):
    size = r * 1.12
    scale = size / 64
    art = (
        f'<g transform="translate({num(cx - size / 2)} {num(cy - size / 2)}) scale({scale:.4f})" '
        f'fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" '
        f'stroke="{{ink}}">{ICONS[icon]}</g>'
    )
    out = []
    if state == "done":
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{r + 9}" fill="none" stroke="{GOLD}" stroke-opacity=".28" stroke-width="1"/>')
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="url(#medal)"/>')
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{r - 6}" fill="none" stroke="{INK}" stroke-opacity=".35" stroke-width="1.2"/>')
        out.append(art.replace("{ink}", INK))
    elif state == "active":
        length = 2 * math.pi * r
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{PANEL}" stroke="{GOLD_DEEP}" stroke-opacity=".7" stroke-width="1.4"/>')
        out.append(
            f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="none" stroke="{AMBER}" stroke-width="4" stroke-linecap="round" '
            f'stroke-dasharray="{num(length * progress)} {num(length)}" transform="rotate(-90 {cx} {cy})"/>'
        )
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{r - 7}" fill="none" stroke="{GOLD}" stroke-opacity=".18" stroke-width="1"/>')
        out.append(art.replace("{ink}", TEXT))
    elif state == "open":
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{PANEL}" stroke="{GOLD}" stroke-opacity=".8" stroke-width="1.4"/>')
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{r - 7}" fill="none" stroke="{GOLD}" stroke-opacity=".22" stroke-width="1"/>')
        out.append(art.replace("{ink}", GOLD))
    else:
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{INK}" stroke="{FAINT}" stroke-opacity=".7" stroke-width="1.2" stroke-dasharray="3 6"/>')
        out.append(f'<g opacity=".55">{art.replace("{ink}", FAINT)}</g>')
    return "".join(out)


def wire(points, state):
    d = "M" + " L".join(f"{num(x)} {num(y)}" for x, y in points)
    if state == "done":
        return f'<path d="{d}" fill="none" stroke="{GOLD}" stroke-opacity=".85" stroke-width="2"/>'
    if state == "open":
        return f'<path d="{d}" fill="none" stroke="{GOLD_DEEP}" stroke-opacity=".7" stroke-width="1.6"/>'
    return f'<path d="{d}" fill="none" stroke="{FAINT}" stroke-opacity=".55" stroke-width="1.4" stroke-dasharray="4 7"/>'


def globe(cx, cy, r, tilt):
    rings = [f'<circle cx="{cx}" cy="{cy}" r="{r}"/>']
    for k in range(1, 6):
        rings.append(f'<ellipse cx="{cx}" cy="{cy}" rx="{num(r * math.cos(math.radians(k * 15)))}" ry="{r}"/>')
    for k in range(-5, 6):
        y = cy + r * math.sin(math.radians(k * 15))
        half = r * math.cos(math.radians(k * 15))
        rings.append(f'<path d="M{num(cx - half)} {num(y)} H{num(cx + half)}"/>')
    return (
        f'<g transform="rotate({tilt} {cx} {cy})" fill="none" stroke="{GOLD}" stroke-opacity=".07" stroke-width="1">'
        + "".join(rings)
        + "</g>"
    )


def frame():
    out = [
        f'<rect x="56" y="56" width="{W - 112}" height="{H - 112}" fill="none" stroke="{GOLD}" stroke-opacity=".34" stroke-width="1.5"/>',
        f'<rect x="70" y="70" width="{W - 140}" height="{H - 140}" fill="none" stroke="{GOLD}" stroke-opacity=".12" stroke-width="1"/>',
    ]
    arm = 46
    for x, y, dx, dy in [(48, 48, 1, 1), (W - 48, 48, -1, 1), (48, H - 48, 1, -1), (W - 48, H - 48, -1, -1)]:
        out.append(
            f'<path d="M{x} {y + dy * arm} V{y} H{x + dx * arm}" fill="none" stroke="{GOLD}" stroke-width="2.5"/>'
        )
    ticks = []
    for i, y in enumerate(range(120, H - 110, 40)):
        size = 9 if i % 5 == 0 else 5
        ticks.append(f"M57 {y} h{size} M{W - 57} {y} h-{size}")
    out.append(f'<path d="{" ".join(ticks)}" stroke="{GOLD}" stroke-opacity=".3" stroke-width="1"/>')
    return "".join(out)


def build():
    root = (CX, 340)
    title_size, rows = 176, [590, 820, 1050, 1280]
    half = title_size / 2
    left, right = 300, 900
    seal_cy, seal = 1512, 150

    tree = []
    # The trunk runs behind the title: draw it only in the gaps between characters.
    trunk = [(root[1] + 52 + 10, rows[0] - half - 8)]
    for a, b in zip(rows, rows[1:]):
        trunk.append((a + half - 6, b - half + 6))
    trunk.append((rows[-1] + half + 4, seal_cy - seal / 2 - 14))
    for top, bottom in trunk:
        tree.append(wire([(CX, top), (CX, bottom)], "done"))
    junction = (rows[0] + rows[1]) / 2
    for x in (left, right):
        tree.append(wire([(CX - 30 if x < CX else CX + 30, junction), (x, junction), (x, rows[1] - 40)], "done"))
    tree.append(wire([(CX - 30, junction), (CX + 30, junction)], "done"))
    tree.append(wire([(left, rows[1] + 40), (left, rows[2] - 40)], "done"))
    tree.append(wire([(left, rows[2] + 40), (left, rows[3] - 40)], "open"))
    tree.append(wire([(right, rows[1] + 40), (right, rows[2] - 40)], "done"))
    tree.append(wire([(right, rows[2] + 40), (right, rows[3] - 40)], "locked"))

    nodes = [
        node(*root, 52, "crown", "done"),
        node(left, rows[1], 40, "industry", "done"),
        node(left, rows[2], 40, "science", "active", 0.62),
        node(left, rows[3], 40, "trade", "open"),
        node(right, rows[1], 40, "army", "done"),
        node(right, rows[2], 40, "eagle", "open"),
        node(right, rows[3], 40, "diplomacy", "locked"),
    ]

    title = "".join(ideograph(HEAVY, ch, CX, cy, title_size) for ch, cy in zip("国策档案", rows))
    header = line(SEMI, "NATIONAL FOCUS ARCHIVE", CX, 182, 23, 0.42)
    footer = line(SEMI, "骨架版 · v0.17.3", CX, 1694, 24, 0.18)
    seal_size = 60
    seal_glyphs = "".join(
        ideograph(HEAVY, ch, CX + dx, seal_cy + dy, seal_size)
        for ch, dx, dy in [("命", 33, -33), ("定", 33, 33), ("之", -33, -33), ("诗", -33, 33)]
    )

    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<title>国策档案</title>
<defs>
  <radialGradient id="light" cx="{CX}" cy="860" r="980" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#1f2b23"/><stop offset=".55" stop-color="{BG}"/><stop offset="1" stop-color="#090e0b"/>
  </radialGradient>
  <radialGradient id="glow" cx="{root[0]}" cy="{root[1]}" r="150" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="{GOLD}" stop-opacity=".22"/><stop offset="1" stop-color="{GOLD}" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="medal" cx=".38" cy=".32" r=".8">
    <stop offset="0" stop-color="#efdca0"/><stop offset=".6" stop-color="{GOLD}"/><stop offset="1" stop-color="{GOLD_DEEP}"/>
  </radialGradient>
  <linearGradient id="ivory" x1="0" y1="{rows[0] - half}" x2="0" y2="{rows[-1] + half}" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#f3eedf"/><stop offset="1" stop-color="#d6c9a4"/>
  </linearGradient>
  <filter id="lift" x="-10%" y="-10%" width="120%" height="120%">
    <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000" flood-opacity=".55"/>
  </filter>
  <filter id="grain" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="7"/>
    <feColorMatrix values="0 0 0 0 .92  0 0 0 0 .88  0 0 0 0 .78  0 0 0 .9 -.32"/>
  </filter>
  <filter id="stamp" x="-5%" y="-5%" width="110%" height="110%">
    <!-- Rough edges from fine noise, then a few paler patches from coarse noise. -->
    <feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves="2" seed="3" result="fine"/>
    <feDisplacementMap in="SourceGraphic" in2="fine" scale="2.6" xChannelSelector="R" yChannelSelector="G" result="rough"/>
    <feTurbulence type="fractalNoise" baseFrequency=".03" numOctaves="3" seed="11" result="blot"/>
    <feColorMatrix in="blot" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1 1.45" result="ink"/>
    <feComposite in="rough" in2="ink" operator="in"/>
  </filter>
</defs>
<rect width="{W}" height="{H}" fill="url(#light)"/>
{globe(CX, 935, 540, -14)}
<circle cx="{root[0]}" cy="{root[1]}" r="150" fill="url(#glow)"/>
<rect width="{W}" height="{H}" filter="url(#grain)" opacity=".07"/>
{frame()}
<g fill="{GOLD}">{header}</g>
<path d="M{CX - 150} 214 H{CX - 14} M{CX + 14} 214 H{CX + 150}" stroke="{GOLD}" stroke-opacity=".45" stroke-width="1"/>
<path d="M{CX} 208 l6 6 -6 6 -6 -6z" fill="{GOLD}"/>
<g>{"".join(tree)}</g>
<g>{"".join(nodes)}</g>
<g fill="url(#ivory)" filter="url(#lift)">{title}</g>
<g transform="rotate(-4 {CX} {seal_cy})" filter="url(#stamp)">
  <rect x="{CX - seal / 2}" y="{seal_cy - seal / 2}" width="{seal}" height="{seal}" rx="6" fill="{SEAL}"/>
  <rect x="{CX - seal / 2 + 8}" y="{seal_cy - seal / 2 + 8}" width="{seal - 16}" height="{seal - 16}" rx="3" fill="none" stroke="{SEAL_INK}" stroke-width="2.5"/>
  <g fill="{SEAL_INK}">{seal_glyphs}</g>
</g>
<g fill="{MUTED}">{footer}</g>
</svg>
"""


if __name__ == "__main__":
    with open(sys.argv[1], "w", encoding="utf-8") as out:
        out.write(build())
