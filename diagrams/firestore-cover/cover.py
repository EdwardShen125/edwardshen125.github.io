"""Compose a 1200x630 social cover from the redacted Query Insights screenshots."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
DL = Path("/Users/mac1178/Downloads")
OUT = Path("/Users/mac1178/Documents/github.com/EdwardShen125/edwardshen125.github.io/"
           "source/_posts/"
           "cutting-firestore-reads-by-moving-a-scan-off-the-request-path/cover.png")

BEFORE = DL / "63f704d2-f560-490b-a4d4-84d15d28f0eb-redacted.png"
AFTER = DL / "e182d7ac-4d7f-4ba2-9a6d-eb7450c0c784-redacted.png"
# Same 930px-wide slice of each table so the columns line up across the two strips.
BEFORE_ROW = (117, 624, 1007, 720)
AFTER_ROW = (68, 130, 958, 226)
STRIP_W = 1040

BG = (33, 33, 33)
WHITE = (232, 234, 237)
GREY = (154, 160, 166)
ACCENT = (138, 180, 248)
VAR = HERE / "fonts" / "Roboto-VF.ttf"

L, R = 80, 1120


def font(size, weight):
    f = ImageFont.truetype(str(VAR), size=size)
    try:
        f.set_variation_by_axes([100, weight])  # wdth, wght
    except Exception:
        pass
    return f


def strip(path, box):
    im = Image.open(path).convert("RGB").crop(box)
    return im.resize((STRIP_W, round(im.height * STRIP_W / im.width)), Image.LANCZOS)


def arrow(d, x0, x1, y, color, shaft=7, head=20):
    d.line([(x0, y), (x1 - head * 0.6, y)], fill=color, width=shaft)
    d.polygon([(x1, y), (x1 - head, y - head * 0.75), (x1 - head, y + head * 0.75)], fill=color)


def main():
    W, H = 1200, 630
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)

    d.text((L, 56), "FIRESTORE QUERY INSIGHTS  ·  ONE QUERY SHAPE, BEFORE AND AFTER", font=font(17, 500), fill=GREY)

    base = 172
    big = font(80, 700)
    x = L
    d.text((x, base), "31.6M", font=big, fill=WHITE, anchor="ls")
    x += big.getlength("31.6M") + 22
    arrow(d, x, x + 64, base - 28, WHITE)
    x += 64 + 22
    d.text((x, base), "13.2M", font=big, fill=WHITE, anchor="ls")
    x += big.getlength("13.2M") + 24
    d.text((x, base), "read operations", font=font(30, 400), fill=GREY, anchor="ls")
    d.text((R, base), "−58%", font=font(44, 500), fill=ACCENT, anchor="rs")

    before = strip(BEFORE, BEFORE_ROW)
    after = strip(AFTER, AFTER_ROW)

    d.text((L, 236), "BEFORE  ·  22 H", font=font(16, 500), fill=GREY)
    im.paste(before, (L, 262))
    d.text((L, 262 + before.height + 27), "AFTER  ·  22 H", font=font(16, 500), fill=GREY)
    im.paste(after, (L, 262 + before.height + 53))

    d.text((L, 584), "Scan moved off the request path into a rate-limited Redis queue", font=font(22, 400), fill=GREY, anchor="ls")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    im.save(OUT)
    print("saved", OUT, im.size, "strip", before.size)


if __name__ == "__main__":
    main()
