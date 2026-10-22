"""Renders docs/demo.gif from a saved find_available_restaurants result.

Draws the frames offscreen (no screen recording), so making the demo never
takes over the desktop. macOS fonts; needs Pillow and ffmpeg.

    python3 scripts/make-demo-gif.py result.json docs/demo.gif
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 1040, 600
BG, PANEL, TEXT, DIM, ACCENT, GREEN, AMBER = "#0f1115", "#171a21", "#e6e6e6", "#8a8f98", "#7aa2f7", "#9ece6a", "#e0af68"
FONT = "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc"
BOLD = "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"


def font(size, bold=False):
    return ImageFont.truetype(BOLD if bold else FONT, size)


def main(result_path, out_path):
    result = json.loads(Path(result_path).read_text())
    criteria, checked = result["criteria"], result["checked"]
    locations = [location["query"] for location in result["locations"]]
    dates = criteria["dates"]
    short = lambda date: f"{int(date[5:7])}/{int(date[8:10])}"

    prompt = (
        f"Find a restaurant with a private room for {criteria['party']} people within "
        f"{criteria['max_walk_minutes']} minutes of {locations[0]} and {locations[1]}, in the next {len(dates)} days, for dinner"
    )
    call = f"find_available_restaurants(locations: [{', '.join(locations)}], party: {criteria['party']})"
    defaults = (
        f"defaults from preferences: {short(dates[0])}–{short(dates[-1])} · {criteria['window']['start']}–{criteria['window']['end']}"
        f" · private room · within {criteria['max_walk_minutes']} min walk"
    )
    progress = [f"Searching near {result['locations'][0]['name']} on {dates[0]}", f"Searching near {result['locations'][1]['name']} on {dates[-1]}"]
    progress += [f"Checking open times: {found['name']}" for found in result["results"][:3]]
    summary = f"{checked['candidates']} candidates · {checked['within_walk']} within walking range of both · {checked['with_slots']} with a room for {criteria['party']} and open times"

    rows = []
    for found in result["results"][:5]:
        walks = " · ".join(f"{walk['location'].removesuffix('駅')} {walk['minutes']}分" for walk in found["walk_minutes"])
        slots = "  ".join(f"{short(day['date'])} {day['times'][0]}–{day['times'][-1]}" for day in found["open_slots"][:2])
        rows.append((found["name"], f"{found['score']:.2f}", (found["genre"] or "").split("、")[0], walks, slots))

    frames = []

    def frame(typed_prompt, lines, hold=1):
        image = Image.new("RGB", (WIDTH, HEIGHT), BG)
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((20, 20, WIDTH - 20, HEIGHT - 20), radius=14, fill=PANEL)
        for i, color in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
            draw.ellipse((42 + i * 22, 38, 54 + i * 22, 50), fill=color)
        draw.text((WIDTH // 2, 44), "Claude Code · tabelog-mcp", font=font(15), fill=DIM, anchor="mm")
        y = 82
        draw.text((44, y), ">", font=font(18, True), fill=ACCENT)
        wrapped, line = [], ""
        for word in typed_prompt.split(" "):
            if draw.textlength(f"{line} {word}", font=font(18)) > WIDTH - 130:
                wrapped.append(line)
                line = word
            else:
                line = f"{line} {word}".strip()
        wrapped.append(line)
        for part in wrapped:
            draw.text((66, y), part, font=font(18), fill=TEXT)
            y += 28
        y += 10
        for kind, content in lines:
            if kind == "call":
                draw.text((44, y), "●", font=font(16), fill=GREEN)
                draw.text((66, y), content, font=font(16, True), fill=TEXT)
                y += 28
            elif kind in ("dim", "progress"):
                draw.text((66, y), ("… " if kind == "progress" else "") + content, font=font(14), fill=DIM)
                y += 22
            elif kind == "summary":
                y += 6
                draw.text((66, y), content, font=font(15, True), fill=AMBER)
                y += 32
            elif kind == "row":
                name, score, genre, walks, slots = content
                draw.text((66, y), name, font=font(16, True), fill=TEXT)
                draw.text((420, y), score, font=font(16), fill=AMBER)
                draw.text((475, y), genre, font=font(15), fill=DIM)
                draw.text((560, y), walks, font=font(15), fill=TEXT)
                draw.text((66, y + 22), slots, font=font(14), fill=GREEN)
                y += 52
        draw.text((WIDTH - 40, HEIGHT - 40), "Real search results from 2026-10-22, replayed", font=font(13), fill=DIM, anchor="rs")
        frames.extend([image] * hold)

    for end in range(0, len(prompt) + 1, 4):
        frame(prompt[:end], [])
    frame(prompt, [], hold=6)
    lines = [("call", call)]
    frame(prompt, lines, hold=6)
    lines.append(("dim", defaults))
    frame(prompt, lines, hold=8)
    for message in progress:
        frame(prompt, lines + [("progress", message)], hold=5)
    lines.append(("summary", summary))
    frame(prompt, lines, hold=6)
    for row in rows:
        lines.append(("row", row))
        frame(prompt, lines, hold=5)
    frame(prompt, lines, hold=40)

    with tempfile.TemporaryDirectory() as directory:
        for index, image in enumerate(frames):
            image.save(f"{directory}/{index:04d}.png")
        palette = f"{directory}/palette.png"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "10", "-i", f"{directory}/%04d.png", "-vf", "palettegen=max_colors=64", palette], check=True)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-framerate", "10", "-i", f"{directory}/%04d.png", "-i", palette, "-lavfi", "paletteuse=dither=none", "-loop", "0", out_path],
            check=True,
        )


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
