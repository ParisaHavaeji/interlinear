import { describe, expect, it } from 'vitest'
import { collapseWhitespace, decodeEntities, htmlToBlocks, parseElements, tokenize } from '../src/import/markup.ts'

describe('decodeEntities', () => {
  it('decodes numeric, hex and named references', () => {
    expect(decodeEntities('a&amp;b &#8220;q&#x201D; &auml;&szlig; &nbsp;x')).toBe('a&b “q” äß  x')
  })

  it('leaves unknown names and bare ampersands alone', () => {
    expect(decodeEntities('Tom &amp Jerry &bogus; &#xZZ;')).toBe('Tom &amp Jerry &bogus; &#xZZ;')
  })
})

describe('tokenize', () => {
  it('produces open, text and close tokens with lowercased names and attributes', () => {
    const toks = tokenize('<P Class="x" id=y>Hi</P>')
    expect(toks).toEqual([
      { type: 'open', name: 'p', attrs: { class: 'x', id: 'y' }, selfClosing: false },
      { type: 'text', text: 'Hi' },
      { type: 'close', name: 'p', attrs: {}, selfClosing: false },
    ])
  })

  it('handles self-closing tags, with and without a space before the slash', () => {
    expect(tokenize('<br/><br />')).toEqual([
      { type: 'open', name: 'br', attrs: {}, selfClosing: true },
      { type: 'open', name: 'br', attrs: {}, selfClosing: true },
    ])
    expect(tokenize('<br class="c"/>')[0]).toMatchObject({ name: 'br', attrs: { class: 'c' }, selfClosing: true })
  })

  it('drops comments, doctype, processing instructions and raw script/style content', () => {
    const src = '<?xml version="1.0"?><!DOCTYPE html><!-- c --><style>p { x: ">" }</style><script>if (a < b) {}</script>t'
    const toks = tokenize(src)
    expect(toks.filter((t) => t.type === 'text')).toEqual([{ type: 'text', text: 't' }])
    expect(toks.map((t) => (t.type === 'text' ? '#' : t.name))).toEqual(['style', 'style', 'script', 'script', '#'])
  })

  it('treats a bare "<" as text and keeps namespace prefixes', () => {
    expect(tokenize('a < b')).toEqual([{ type: 'text', text: 'a < b' }])
    expect(tokenize('<dc:title>T</dc:title>')[0]).toMatchObject({ name: 'dc:title' })
  })

  it('passes CDATA through without entity decoding', () => {
    expect(tokenize('<a><![CDATA[x &amp; y]]></a>')[1]).toEqual({ type: 'text', text: 'x &amp; y' })
  })
})

describe('parseElements', () => {
  it('lists elements in document order with their descendant text', () => {
    const els = parseElements('<r><a x="1">one<b>two</b></a><c/>three</r>')
    expect(els.map((e) => [e.name, e.text])).toEqual([
      ['r', 'onetwothree'],
      ['a', 'onetwo'],
      ['b', 'two'],
      ['c', ''],
    ])
    expect(els[1].attrs).toEqual({ x: '1' })
  })
})

describe('collapseWhitespace', () => {
  it('collapses whitespace and strips soft hyphens and zero-width characters', () => {
    expect(collapseWhitespace('  Ver­lag​  x\n\ty z ')).toBe('Verlag x y z')
  })
})

describe('htmlToBlocks', () => {
  const texts = (html: string) => htmlToBlocks(html).map((b) => b.text)

  it('rejoins a word split across inline elements and adds nothing between them', () => {
    expect(texts('<p><span>Vorbi</span><span>ld und </span><em>Schule</em>.</p>')).toEqual(['Vorbild und Schule.'])
  })

  it('starts a paragraph only at block elements and records tag and class', () => {
    const blocks = htmlToBlocks('<body><h1 class="t">Head</h1><p class="b">One</p><div>Two</div></body>')
    expect(blocks).toEqual([
      { tag: 'h1', cls: 't', text: 'Head' },
      { tag: 'p', cls: 'b', text: 'One' },
      { tag: 'div', cls: '', text: 'Two' },
    ])
  })

  it('lets a div with block children act as a container, not a paragraph', () => {
    expect(texts('<div class="w">lead<p>a</p>tail<p>b</p></div>')).toEqual(['lead', 'a', 'tail', 'b'])
    expect(htmlToBlocks('<div class="w">lead<p>a</p></div>')[0]).toMatchObject({ tag: 'div', cls: 'w' })
  })

  it('drops endnote markers in <sup> but keeps other superscripts', () => {
    expect(texts('<p>Text<a href="#n1"><sup>1</sup></a> more<sup>*</sup> and 2<sup>nd</sup></p>')).toEqual([
      'Text more and 2nd',
    ])
  })

  it('drops images, svg, head, script and style', () => {
    const html =
      '<html><head><title>T</title><style>p{}</style></head><body><div><svg><text>no</text></svg><img alt="x"/><p>yes</p><script>var a</script></div></body></html>'
    expect(texts(html)).toEqual(['yes'])
  })

  it('treats one <br> as a space and two or more as a paragraph break', () => {
    expect(texts('<p>a<br/>b<br/><br/>c<br/>\n<br/>d</p>')).toEqual(['a b', 'c', 'd'])
  })

  it('collapses whitespace, including line breaks in the source and NBSP', () => {
    expect(texts('<p>\n  Zwei\n  Welten&#160; </p>')).toEqual(['Zwei Welten'])
  })

  it('drops blocks without a letter or digit (ornaments, empty paragraphs)', () => {
    expect(texts('<p>•   •   •</p><p> </p><p>&#160;</p><p>***</p><p>ok</p>')).toEqual(['ok'])
  })

  it('flushes on <hr> and tolerates unclosed paragraphs', () => {
    expect(texts('<p>a<hr/>b<p>c')).toEqual(['a', 'b', 'c'])
  })
})
