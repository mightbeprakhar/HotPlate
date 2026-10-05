# BUILD ARTEFACT — crops the six board screenshots into one figure for the report.
from PIL import Image
import glob, os

OUT = os.path.dirname(os.path.abspath(__file__))
TITLES = {
    'riverfront': 'Riverfront', 'bay': 'Bay', 'twincities': 'Twin cities',
    'downtown': 'Downtown', 'gorge': 'Gorge', 'archipelago': 'Archipelago',
}
order = ['riverfront', 'bay', 'twincities', 'downtown', 'gorge', 'archipelago']

# the board occupies the left column, under the 54px top bar
CROP = (16, 66, 1080, 730)
CW, CH = CROP[2] - CROP[0], CROP[3] - CROP[1]
SCALE = 0.60
tw, th = int(CW * SCALE), int(CH * SCALE)

sheet = Image.new('RGB', (tw * 2 + 24, th * 3 + 32), (251, 251, 253))
for k, name in enumerate(order):
    im = Image.open(os.path.join(OUT, '..', 'layout-%s.png' % name)).convert('RGB')
    im = im.crop(CROP).resize((tw, th), Image.LANCZOS)
    sheet.paste(im, (8 + (k % 2) * (tw + 8), 8 + (k // 2) * (th + 8)))
sheet.save(os.path.join(OUT, 'fig-layouts.png'))
print('fig-layouts.png', sheet.size)
