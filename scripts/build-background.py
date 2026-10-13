# Build the ASCII gutter artwork from the cropped hero sources.
# Last modified: 2026-10-03 12:20

# Emit packed 4-bit ink strips that the page renders as live text at device resolution.
import argparse
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

COLUMNS = 160
ROWS = 200
STRIP_ASPECT = COLUMNS * 0.6 / ROWS
CELL_RATIO = 0.6
GLYPHS = " .,:;~!i1tfLCG0@"
INK_RAMP = (
	"#93a4bd", "#8799b3", "#7b8da9", "#70829f", "#657795", "#5b6c8b",
	"#516181", "#485677", "#404c6d", "#384263", "#313859", "#2a304e",
	"#232943", "#1c2138", "#151a2c", "#0c1220",
)
TONE_FLOOR = 0.22
TONE_SPAN = 0.72
TONE_GAMMA = 1.20
TONE_STRETCH = 20
PAPER = (251, 250, 244)
# Each hero is cropped around its detected figure so the face and body stay centred.
# The roster is exactly the set of cropped sources; nothing else is converted.
SOURCES = (
	("abaddon", "Abaddon", "Offlane"),
	("antimage", "Anti-Mage", "Carry"),
	("axe", "Axe", "Offlane"),
	("bloodseeker", "Bloodseeker", "Carry"),
	("chaosknight", "Chaos Knight", "Carry"),
	("doom", "Doom", "Offlane"),
	("drowranger", "Drow Ranger", "Carry"),
	("emberspirit", "Ember Spirit", "Mid"),
	("facelessvoid", "Faceless Void", "Carry"),
	("invoker", "Invoker", "Mid"),
	("juggernaut", "Juggernaut", "Carry"),
	("kunkka", "Kunkka", "Mid"),
	("legioncommander", "Legion Commander", "Offlane"),
	("lifestealer", "Lifestealer", "Carry"),
	("lina", "Lina", "Mid"),
	("luna", "Luna", "Carry"),
	("magnus", "Magnus", "Offlane"),
	("medusa", "Medusa", "Carry"),
	("morphling", "Morphling", "Carry"),
	("nagasiren", "Naga Siren", "Carry"),
	("ogremagi", "Ogre Magi", "Support"),
	("phantomassassin", "Phantom Assassin", "Carry"),
	("pudge", "Pudge", "Support"),
	("queenofpain", "Queen of Pain", "Mid"),
	("rubick", "Rubick", "Support"),
	("shadowfiend", "Shadow Fiend", "Mid"),
	("slark", "Slark", "Carry"),
	("spectre", "Spectre", "Carry"),
	("stormspirit", "Storm Spirit", "Mid"),
	("sven", "Sven", "Carry"),
	("terrorblade", "Terrorblade", "Carry"),
	("ursa", "Ursa", "Carry"),
	("windranger", "Windranger", "Mid"),
	("wraithking", "Wraith King", "Carry"),
	("zeus", "Zeus", "Mid"),
)

# Per-hero crop centres; everything else defaults to the middle of the image.
CENTERS = {
	"medusa": (0.30, 0.50),
	"axe": (0.50, 0.40),
	"slark": (0.40, 0.50),
	"rubick": (0.45, 0.50),
	"facelessvoid": (0.50, 0.55),
	"juggernaut": (0.45, 0.45),
	"wraithking": (0.62, 0.55),
	"ursa": (0.42, 0.50),
}

# Heroes whose white studio backdrop is lifted to a gray wash like the other strips.
GRAY_SOURCES = {"abaddon", "ogremagi", "slark"}
GRAY_TONE = 3

# Clamp a value into an inclusive range.
def clamp(value, low, high):
	return max(low, min(high, value))

# Crop the largest strip-aspect window centred on the configured focus.
# White studio backdrops are lifted to a gray wash after encoding.
def sample(source, slug):
	image = Image.open(source).convert("RGB")
	width, height = image.size
	focus_x, focus_y = CENTERS.get(slug, (0.5, 0.5))
	center_x = clamp(focus_x, 0.0, 1.0) * width
	center_y = clamp(focus_y, 0.0, 1.0) * height
	half_width = min(center_x, width - center_x, (min(center_y, height - center_y)) * STRIP_ASPECT)
	half_height = half_width / STRIP_ASPECT
	box = (int(round(center_x - half_width)), int(round(center_y - half_height)), int(round(center_x + half_width)), int(round(center_y + half_height)))
	patch = image.crop(box)
	mask = None
	if slug in GRAY_SOURCES:
		mask = patch.convert("L").point(lambda v: 255 if v > 242 else 0).filter(ImageFilter.GaussianBlur(1.5)).resize((COLUMNS, ROWS), Image.Resampling.LANCZOS)
	gray = ImageOps.autocontrast(patch.convert("L"), cutoff=0.6)
	gray = ImageEnhance.Contrast(gray).enhance(1.14)
	levels = bytearray(encode(gray.resize((COLUMNS, ROWS), Image.Resampling.LANCZOS)))
	if mask is not None:
		for index, value in enumerate(mask.getdata()):
			if value > 128 and levels[index] < GRAY_TONE:
				levels[index] = GRAY_TONE
	return bytes(levels)

# Quantize luminance into 16 ink levels, one nibble per cell.
def encode(samples):
	data = bytearray(COLUMNS * ROWS)
	for row in range(ROWS):
		for column in range(COLUMNS):
			ink = 1.0 - samples.getpixel((column, row)) / 255.0
			ink = min(1.0, max(0.0, (ink - TONE_FLOOR) / TONE_SPAN)) ** TONE_GAMMA
			data[row * COLUMNS + column] = min(15, int(ink * TONE_STRETCH))
	return bytes(data)

# Rasterize a static strip for browsers that never run the gallery script.
def preview(levels, destination, font, cell_width=2, cell_height=4):
	art = Image.new("RGB", (COLUMNS * cell_width, ROWS * cell_height), PAPER)
	draw = ImageDraw.Draw(art)
	for row in range(ROWS):
		for column in range(COLUMNS):
			tone = levels[row * COLUMNS + column]
			if not tone:
				continue
			draw.text((column * cell_width, row * cell_height), GLYPHS[tone], font=font, fill=INK_RAMP[tone], anchor="lt")
	art.save(destination, "WEBP", quality=88, method=6)

# Download the splash when it is not already cached, then convert the whole selection.
def main():
	parser = argparse.ArgumentParser(description="Build the website's ASCII gutter artwork from cropped hero portraits.")
	parser.add_argument("--source-dir", type=Path, default=Path(__file__).resolve().parents[1] / "assets" / "sources")
	parser.add_argument("--font", type=Path, default=Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"))
	arguments = parser.parse_args()
	arguments.source_dir.mkdir(parents=True, exist_ok=True)
	output = Path(__file__).resolve().parents[1] / "assets" / "portraits"
	output.mkdir(parents=True, exist_ok=True)
	font = ImageFont.truetype(str(arguments.font), 4)
	frames = []
	for index, (slug, hero, role) in enumerate(SOURCES):
		matches = sorted(arguments.source_dir.glob(f"{slug}.*"))
		if not matches:
			raise FileNotFoundError(f"Cropped source missing for {slug}")
		original = matches[0]
		levels = sample(original, slug)
		(output / f"{slug}.bin").write_bytes(levels)
		frames.append({
			"id": slug,
			"hero": hero,
			"role": role,
			"file": f"{slug}.bin",
		})
		if index == 0:
			preview(levels, output / "preview.webp", font)
		print(f"Converted {hero} ({role}): {len(levels)} ink levels.")
	manifest = {
		"columns": COLUMNS,
		"rows": ROWS,
		"cellRatio": CELL_RATIO,
		"glyphs": GLYPHS,
		"inkRamp": list(INK_RAMP),
		"buildSeconds": 2,
		"holdSeconds": 5,
		"exitSeconds": 2,
		"preview": "preview.webp",
		"frames": frames,
	}
	(output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent="\t") + "\n")
	keep = {frame["file"] for frame in frames} | {"manifest.json", "preview.webp"}
	for stale in output.iterdir():
		if stale.name not in keep:
			stale.unlink()
	print(f"Built {len(frames)} ink strips in {output}.")

# Run the converter only when invoked as a build tool.
if __name__ == "__main__":
	main()
