from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTCollection
from pathlib import Path
out=Path(__file__).parent
def build(name):
    fb=FontBuilder(1000,isTTF=True)
    chars=' 中文报告金额测试EnglishRésuméΚαλημέρα12.50'
    cmap={ord(c):'u%04X'%ord(c) for c in sorted(set(chars))}
    order=['.notdef']+list(cmap.values());fb.setupGlyphOrder(order);fb.setupCharacterMap(cmap)
    glyphs={}
    for n in order:
        p=TTGlyphPen(None)
        if n != 'u0020':
            p.moveTo((100,100));p.lineTo((500,100));p.lineTo((500,700));p.lineTo((100,700));p.closePath()
        glyphs[n]=p.glyph()
    fb.setupGlyf(glyphs);fb.setupHorizontalMetrics({n:(600,0) for n in order});fb.setupHorizontalHeader(ascent=800,descent=-200)
    fb.setupNameTable({'familyName':name,'styleName':'Regular','uniqueFontIdentifier':name,'fullName':name,'psName':name})
    fb.setupOS2(sTypoAscender=800,sTypoDescender=-200,usWinAscent=800,usWinDescent=200);fb.setupPost();fb.setupMaxp()
    fb.font["head"].created = 3400000000
    fb.font["head"].modified = 3400000000
    fb.font.recalcTimestamp = False
    return fb.font
build('CyreneTestStandalone').save(out/'standalone.ttf')
ttc=TTCollection();ttc.fonts=[build('MicrosoftYaHei'),build('SimSun')];ttc.save(out/'collection.ttc')
