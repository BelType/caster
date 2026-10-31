# Builds UnclassifiedMarks.ttf (run beside it: python3 make-unclassified-marks.py, needs fontTools) — a five-glyph TrueType font written for Caster's tests (no third-party outlines).
# Bet (U+05D1), Lamed (U+05DC): GDEF class 1 (base). Qamats (U+05B8): advance 300, in GDEF's table NOT AT ALL (class 0), like Arial Unicode's Hebrew points.
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables import otTables as ot
def box(x0, y0, x1, y1):
    p = TTGlyphPen(None); p.moveTo((x0, y0)); p.lineTo((x0, y1)); p.lineTo((x1, y1)); p.lineTo((x1, y0)); p.closePath(); return p.glyph()
order = ['.notdef', 'space', 'bet', 'lamed', 'qamats']
fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder(order)
fb.setupCharacterMap({0x20: 'space', 0x05D1: 'bet', 0x05DC: 'lamed', 0x05B8: 'qamats'})
fb.setupGlyf({'.notdef': box(50, 0, 450, 700), 'space': TTGlyphPen(None).glyph(), 'bet': box(50, 0, 550, 700), 'lamed': box(50, 0, 650, 800), 'qamats': box(100, -150, 200, -50)})
fb.setupHorizontalMetrics({'.notdef': (500, 50), 'space': (250, 0), 'bet': (600, 50), 'lamed': (700, 50), 'qamats': (300, 100)})
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({'familyName': 'Caster Unclassified Marks', 'styleName': 'Regular'})
fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
fb.setupPost()
# GDEF: only the two letters are classified (1 = base); qamats is left out, so its class is 0.
gdef = newTable('GDEF'); g = ot.GDEF(); g.Version = 0x00010000
cd = ot.GlyphClassDef(); cd.classDefs = {'bet': 1, 'lamed': 1}; g.GlyphClassDef = cd
g.AttachList = None; g.LigCaretList = None; g.MarkAttachClassDef = None
gdef.table = g; fb.font['GDEF'] = gdef
fb.save('UnclassifiedMarks.ttf')
