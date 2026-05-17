import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { toPng } from 'html-to-image'
import jsPDF from 'jspdf'
import JSZip from 'jszip'
import { createClient } from '@supabase/supabase-js'

// ---------- Supabase client ----------
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://your-project.supabase.co'
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'your-anon-key'
const supabase = createClient(supabaseUrl, supabaseAnonKey)

function App() {
  // ---------- State ----------
  const [images, setImages] = useState([])
  const [activeImageId, setActiveImageId] = useState(null)
  const [width, setWidth] = useState(80)
  const [verticalScale, setVerticalScale] = useState(0.45)
  const [charSet, setCharSet] = useState('@%#*+=-:. ')
  const [customChars, setCustomChars] = useState('@%#*+=-:. ')
  const [useCustomChars, setUseCustomChars] = useState(false)
  const [ditherMethod, setDitherMethod] = useState('none')
  const [invert, setInvert] = useState(false)
  const [brightness, setBrightness] = useState(0)
  const [contrast, setContrast] = useState(100)
  const [batchMode, setBatchMode] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [textColor, setTextColor] = useState('#2E2A28')
  const [bgColor, setBgColor] = useState('#FAF6EF')
  const [pngScale, setPngScale] = useState(2)
  const [transparentBg, setTransparentBg] = useState(false)
  const asciiRef = useRef(null)

  // Auth
  const [user, setUser] = useState(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authMode, setAuthMode] = useState('signin')
  const [loading, setLoading] = useState(false)

  // Cloud data
  const [cloudPresets, setCloudPresets] = useState([])
  const [cloudArts, setCloudArts] = useState([])
  const [fontMetrics, setFontMetrics] = useState(null)

  // Modal state for gallery
  const [modalOpen, setModalOpen] = useState(false)
  const [modalContent, setModalContent] = useState('')
  const [modalTitle, setModalTitle] = useState('')

  // Local presets
  const [presets, setPresets] = useState(() => {
    const saved = localStorage.getItem('charforge-presets')
    return saved ? JSON.parse(saved) : []
  })
  useEffect(() => {
    localStorage.setItem('charforge-presets', JSON.stringify(presets))
  }, [presets])

  // ---------- Auth & Cloud ----------
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setUser(session.user)
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })
    return () => listener?.subscription.unsubscribe()
  }, [])

  const loadCloudPresets = useCallback(async () => {
    if (!user) return
    const { data, error } = await supabase.from('presets').select('*').eq('user_id', user.id)
    if (!error) setCloudPresets(data)
  }, [user])

  const loadGallery = useCallback(async () => {
    if (!user) return
    const { data, error } = await supabase.from('ascii_arts').select('*').eq('user_id', user.id).order('created_at', { ascending: false })
    if (!error) setCloudArts(data)
  }, [user])

  useEffect(() => {
    if (user) {
      loadCloudPresets()
      loadGallery()
    }
  }, [user, loadCloudPresets, loadGallery])

  const savePresetToCloud = async (name, settings) => {
    if (!user) return alert('Please sign in')
    const { error } = await supabase.from('presets').insert({ name, settings })
    if (error) alert(error.message)
    else loadCloudPresets()
  }
  const deleteCloudPreset = async (id) => {
    if (!user) return
    await supabase.from('presets').delete().eq('id', id)
    loadCloudPresets()
  }
  const saveCurrentArt = async (title) => {
    if (!user) return alert('Sign in first')
    if (!currentAscii) return alert('No ASCII art to save')
    const { error } = await supabase.from('ascii_arts').insert({
      title,
      content: currentAscii,
      settings: { width, verticalScale, charSet: activeCharSet, ditherMethod, invert, brightness, contrast, textColor, bgColor, pngScale, transparentBg },
      user_id: user.id
    })
    if (error) alert(error.message)
    else loadGallery()
  }

  const handleAuth = async () => {
    setLoading(true)
    try {
      if (authMode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
      } else {
        const { error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        else alert('Check your email for confirmation!')
      }
    } catch (error) { alert(error.message) }
    finally { setLoading(false) }
  }
  const signOut = async () => { await supabase.auth.signOut() }

  // ---------- Dithering ----------
  const applyFloydSteinberg = (pixels, w, h) => {
    const data = new Uint8ClampedArray(pixels)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4
        const oldR = data[idx], oldG = data[idx+1], oldB = data[idx+2]
        const newR = oldR < 128 ? 0 : 255
        const newG = oldG < 128 ? 0 : 255
        const newB = oldB < 128 ? 0 : 255
        data[idx] = newR; data[idx+1] = newG; data[idx+2] = newB
        const errR = oldR - newR, errG = oldG - newG, errB = oldB - newB
        const distribute = (xoff, yoff, factor) => {
          const nx = x + xoff, ny = y + yoff
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            const nidx = (ny * w + nx) * 4
            data[nidx] += errR * factor
            data[nidx+1] += errG * factor
            data[nidx+2] += errB * factor
          }
        }
        distribute(1, 0, 7/16)
        distribute(-1, 1, 3/16)
        distribute(0, 1, 5/16)
        distribute(1, 1, 1/16)
      }
    }
    return data
  }

  const applyAtkinson = (pixels, w, h) => {
    const data = new Uint8ClampedArray(pixels)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4
        const oldR = data[idx], oldG = data[idx+1], oldB = data[idx+2]
        const newR = oldR < 128 ? 0 : 255
        const newG = oldG < 128 ? 0 : 255
        const newB = oldB < 128 ? 0 : 255
        data[idx] = newR; data[idx+1] = newG; data[idx+2] = newB
        const errR = Math.floor((oldR - newR) / 8)
        const errG = Math.floor((oldG - newG) / 8)
        const errB = Math.floor((oldB - newB) / 8)
        const distribute = (xoff, yoff) => {
          const nx = x + xoff, ny = y + yoff
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            const nidx = (ny * w + nx) * 4
            data[nidx] += errR
            data[nidx+1] += errG
            data[nidx+2] += errB
          }
        }
        distribute(1, 0); distribute(2, 0)
        distribute(-1, 1); distribute(0, 1); distribute(1, 1)
        distribute(0, 2)
      }
    }
    return data
  }

  const adjustPixel = (r, g, b, brightnessVal, contrastVal) => {
    let factor = (259 * (contrastVal + 255)) / (255 * (259 - contrastVal))
    let newR = factor * (r - 128) + 128 + brightnessVal
    let newG = factor * (g - 128) + 128 + brightnessVal
    let newB = factor * (b - 128) + 128 + brightnessVal
    return { r: Math.min(255, Math.max(0, newR)), g: Math.min(255, Math.max(0, newG)), b: Math.min(255, Math.max(0, newB)) }
  }

  const convertToAscii = useCallback((imgElement, w, vScale, chars, invertFlag, bright, contrastVal, dither) => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const aspectRatio = imgElement.height / imgElement.width
    let h = Math.floor(w * aspectRatio * vScale)
    if (h < 1) h = 1
    canvas.width = w
    canvas.height = h
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(imgElement, 0, 0, w, h)
    let imageData = ctx.getImageData(0, 0, w, h)
    let pixels = imageData.data
    if (dither === 'floyd') pixels = applyFloydSteinberg(pixels, w, h)
    if (dither === 'atkinson') pixels = applyAtkinson(pixels, w, h)
    let ascii = ''
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4
        let r = pixels[idx], g = pixels[idx+1], b = pixels[idx+2]
        const adjusted = adjustPixel(r, g, b, bright, contrastVal)
        let brightnessVal = (adjusted.r * 0.299 + adjusted.g * 0.587 + adjusted.b * 0.114) / 255
        if (invertFlag) brightnessVal = 1 - brightnessVal
        const charIndex = Math.floor(brightnessVal * (chars.length - 1))
        ascii += chars[charIndex]
      }
      ascii += '\n'
    }
    return ascii
  }, [])

  const activeCharSet = useCustomChars ? customChars : charSet
  const currentAscii = useMemo(() => {
    if (!activeImageId) return ''
    const img = images.find(i => i.id === activeImageId)
    if (!img || !img.imgElement) return ''
    return convertToAscii(img.imgElement, width, verticalScale, activeCharSet, invert, brightness, contrast, ditherMethod)
  }, [activeImageId, images, width, verticalScale, activeCharSet, invert, brightness, contrast, ditherMethod, convertToAscii])

  const dims = useMemo(() => {
    if (!activeImageId) return { width: 0, height: 0 }
    const img = images.find(i => i.id === activeImageId)
    if (!img) return { width: 0, height: 0 }
    const aspect = img.imgElement.height / img.imgElement.width
    const h = Math.floor(width * aspect * verticalScale)
    return { width, height: h }
  }, [activeImageId, images, width, verticalScale])

  // ---------- Custom font upload ----------
  const handleFontUpload = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const fontData = event.target.result
      const font = new FontFace('CustomFont', fontData)
      font.load().then(loadedFont => {
        document.fonts.add(loadedFont)
        const testDiv = document.createElement('div')
        testDiv.style.fontFamily = 'CustomFont, monospace'
        testDiv.style.fontSize = '16px'
        testDiv.style.position = 'absolute'
        testDiv.style.left = '-9999px'
        testDiv.textContent = 'X'
        document.body.appendChild(testDiv)
        const widthPx = testDiv.offsetWidth
        const heightPx = testDiv.offsetHeight
        document.body.removeChild(testDiv)
        const ratio = heightPx / widthPx
        setFontMetrics({ ratio, name: file.name })
        setVerticalScale(ratio * 0.9)
        alert(`Font loaded. Aspect ratio: ${ratio.toFixed(2)}. Vertical scale set to ${(ratio*0.9).toFixed(2)}. Adjust if needed.`)
      }).catch(() => alert('Invalid font file'))
    }
    reader.readAsArrayBuffer(file)
  }

  // ---------- File handling ----------
  const processFile = (file) => {
    if (!file || !file.type.startsWith('image/')) return
    const img = new Image()
    const reader = new FileReader()
    reader.onload = (event) => {
      img.src = event.target.result
      img.onload = () => {
        const id = Date.now() + '-' + Math.random().toString(36).substr(2, 6)
        const name = file.name
        const newImage = { id, name, url: event.target.result, imgElement: img }
        if (batchMode) {
          setImages(prev => [...prev, newImage])
          setActiveImageId(id)
        } else {
          setImages([newImage])
          setActiveImageId(id)
        }
      }
    }
    reader.readAsDataURL(file)
  }

  const handleFileUpload = (e) => {
    Array.from(e.target.files).forEach(processFile)
  }

  const [isDragging, setIsDragging] = useState(false)
  const handleDrag = (e, dragging) => { e.preventDefault(); e.stopPropagation(); setIsDragging(dragging) }
  const handleDrop = (e) => {
    e.preventDefault(); e.stopPropagation(); setIsDragging(false)
    Array.from(e.dataTransfer.files).forEach(processFile)
  }
  const removeImage = (id) => {
    setImages(prev => prev.filter(i => i.id !== id))
    if (activeImageId === id && images.length > 1) {
      const remaining = images.filter(i => i.id !== id)
      setActiveImageId(remaining[0]?.id || null)
    } else if (images.length === 1) setActiveImageId(null)
  }

  const moveImage = (id, direction) => {
    const index = images.findIndex(i => i.id === id)
    if (direction === 'up' && index === 0) return
    if (direction === 'down' && index === images.length - 1) return
    const newImages = [...images]
    const targetIndex = direction === 'up' ? index - 1 : index + 1
    ;[newImages[index], newImages[targetIndex]] = [newImages[targetIndex], newImages[index]]
    setImages(newImages)
  }

  // ---------- Presets ----------
  const savePreset = () => {
    if (!presetName.trim()) return alert('Enter a name')
    const settings = { width, verticalScale, charSet, customChars, useCustomChars, ditherMethod, invert, brightness, contrast, textColor, bgColor, pngScale, transparentBg }
    setPresets(prev => {
      const existing = prev.find(p => p.name === presetName)
      if (existing) return prev.map(p => p.name === presetName ? { ...p, settings } : p)
      return [...prev, { name: presetName, settings }]
    })
    if (user) savePresetToCloud(presetName, settings)
    setPresetName('')
  }
  const loadPreset = (settings) => {
    setWidth(settings.width)
    setVerticalScale(settings.verticalScale ?? 0.45)
    setCharSet(settings.charSet)
    setCustomChars(settings.customChars || '@%#*+=-:. ')
    setUseCustomChars(settings.useCustomChars || false)
    setDitherMethod(settings.ditherMethod || 'none')
    setInvert(settings.invert)
    setBrightness(settings.brightness)
    setContrast(settings.contrast)
    if (settings.textColor) setTextColor(settings.textColor)
    if (settings.bgColor) setBgColor(settings.bgColor)
    if (settings.pngScale) setPngScale(settings.pngScale)
    if (settings.transparentBg !== undefined) setTransparentBg(settings.transparentBg)
  }
  const deletePreset = (name) => setPresets(prev => prev.filter(p => p.name !== name))

  // ---------- Exports (clone‑based for full capture) ----------
  const exportAsPng = async () => {
    if (!asciiRef.current) return
    const original = asciiRef.current
    const clone = original.cloneNode(true)
    
    clone.style.position = 'absolute'
    clone.style.top = '-9999px'
    clone.style.left = '-9999px'
    clone.style.width = 'max-content'
    clone.style.maxHeight = 'none'
    clone.style.overflow = 'visible'
    clone.style.backgroundColor = transparentBg ? 'transparent' : bgColor
    
    document.body.appendChild(clone)
    
    try {
      const dataUrl = await toPng(clone, {
        backgroundColor: transparentBg ? undefined : bgColor,
        pixelRatio: pngScale,
        cacheBust: true,
      })
      const link = document.createElement('a')
      link.download = `ascii-${dims.width}x${dims.height}.png`
      link.href = dataUrl
      link.click()
    } catch (error) {
      alert('Export failed: ' + error.message)
    } finally {
      document.body.removeChild(clone)
    }
  }

  const exportAsPdf = async () => {
    if (!asciiRef.current) return
    const original = asciiRef.current
    const clone = original.cloneNode(true)
    
    clone.style.position = 'absolute'
    clone.style.top = '-9999px'
    clone.style.left = '-9999px'
    clone.style.width = 'max-content'
    clone.style.maxHeight = 'none'
    clone.style.overflow = 'visible'
    clone.style.backgroundColor = bgColor
    
    document.body.appendChild(clone)
    
    try {
      const dataUrl = await toPng(clone, {
        backgroundColor: bgColor,
        pixelRatio: pngScale,
        cacheBust: true,
      })
      const img = new Image()
      img.src = dataUrl
      img.onload = () => {
        const pdf = new jsPDF({
          orientation: img.width > img.height ? 'landscape' : 'portrait',
          unit: 'px',
          format: [img.width, img.height]
        })
        pdf.addImage(dataUrl, 'PNG', 0, 0, img.width, img.height)
        pdf.save(`ascii-${dims.width}x${dims.height}.pdf`)
      }
    } catch (error) {
      alert('Export failed: ' + error.message)
    } finally {
      document.body.removeChild(clone)
    }
  }

  const exportAsJSON = () => {
    const lines = currentAscii.split('\n').filter(l => l.length > 0)
    navigator.clipboard.writeText(JSON.stringify(lines, null, 2))
    alert('JSON array copied to clipboard.')
  }

  const exportAsCSV = () => {
    const lines = currentAscii.split('\n').filter(l => l.length > 0)
    const csv = lines.map(row => row.split('').join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `ascii-${dims.width}x${dims.height}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  const exportAsTMX = () => {
    const lines = currentAscii.split('\n').filter(l => l.length > 0)
    const mapWidth = lines[0].length
    const mapHeight = lines.length
    let tmx = `<?xml version="1.0" encoding="UTF-8"?>
<map version="1.10" tiledversion="1.10.2" orientation="orthogonal" renderorder="right-down" width="${mapWidth}" height="${mapHeight}" tilewidth="16" tileheight="16" infinite="0">
 <layer id="1" name="ASCII Layer" width="${mapWidth}" height="${mapHeight}">
  <data encoding="csv">`
    for (let y = 0; y < mapHeight; y++) {
      const row = lines[y].split('').map(ch => ch.charCodeAt(0)).join(',')
      tmx += row + (y < mapHeight-1 ? ',' : '')
    }
    tmx += `</data>
 </layer>
</map>`
    const blob = new Blob([tmx], { type: 'application/xml' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `map-${dims.width}x${dims.height}.tmx`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  const exportAsLua = () => {
    const lines = currentAscii.split('\n').filter(l => l.length > 0)
    let lua = 'return {\n'
    for (let i = 0; i < lines.length; i++) {
      lua += `  "${lines[i].replace(/"/g, '\\"')}",\n`
    }
    lua += '}'
    const blob = new Blob([lua], { type: 'text/lua' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `ascii-${dims.width}x${dims.height}.lua`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  const exportAsGIF = async () => {
    if (!batchMode || images.length < 2) return alert('Enable batch mode and upload at least 2 images')
    const GIFModule = await import('gif.js')
    const GIF = GIFModule.default
    const gif = new GIF({ workers: 2, quality: 10, workerScript: 'https://unpkg.com/gif.js@0.2.0/dist/GIFWorker.js' })
    const charWidth = 8
    const charHeight = 16
    for (const img of images) {
      const ascii = convertToAscii(img.imgElement, width, verticalScale, activeCharSet, invert, brightness, contrast, ditherMethod)
      const lines = ascii.split('\n').filter(l => l.length > 0)
      const canvas = document.createElement('canvas')
      canvas.width = dims.width * charWidth * pngScale
      canvas.height = dims.height * charHeight * pngScale
      const ctx = canvas.getContext('2d')
      ctx.scale(pngScale, pngScale)
      ctx.fillStyle = bgColor
      ctx.fillRect(0, 0, canvas.width/pngScale, canvas.height/pngScale)
      ctx.fillStyle = textColor
      ctx.font = `16px monospace`
      for (let y = 0; y < lines.length; y++) {
        ctx.fillText(lines[y], 0, (y+1) * charHeight)
      }
      gif.addFrame(canvas, { delay: 200 })
    }
    gif.on('finished', (blob) => {
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = 'animation.gif'
      link.click()
      URL.revokeObjectURL(link.href)
    })
    gif.render()
  }

  const batchExportAsZip = async () => {
    if (images.length === 0) return alert('No images to export')
    const zip = new JSZip()
    for (const img of images) {
      const ascii = convertToAscii(img.imgElement, width, verticalScale, activeCharSet, invert, brightness, contrast, ditherMethod)
      const name = img.name.replace(/\.[^/.]+$/, '') + '.txt'
      zip.file(name, ascii)
    }
    const content = await zip.generateAsync({ type: 'blob' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(content)
    link.download = `charforge-export-${Date.now()}.zip`
    link.click()
    URL.revokeObjectURL(link.href)
  }

  const resetSettings = () => {
    setWidth(80)
    setVerticalScale(0.45)
    setCharSet('@%#*+=-:. ')
    setCustomChars('@%#*+=-:. ')
    setUseCustomChars(false)
    setDitherMethod('none')
    setInvert(false)
    setBrightness(0)
    setContrast(100)
    setTextColor('#2E2A28')
    setBgColor('#FAF6EF')
    setPngScale(2)
    setTransparentBg(false)
  }

  const charSetOptions = {
    standard: '@%#*+=-:. ',
    blocks: '█▓▒░ ',
    simple: ' .:;+=x%#@',
    braille: '⣿⣶⣧⣷⣾⣽⣻⢿⡿⣟⣯⣷',
    shades: '▓▒░█ ',
    detailed: '@#$%&WX890B%#*+=-:. ',
    artistic: '█✶☯❖◆◇◈◎○●◘◙◦▪▫',
    minimal: ' .!|/\\-~+=*%#@'
  }

  const handleCharSetSelect = (e) => {
    const selected = e.target.value
    if (selected === 'custom') {
      setUseCustomChars(true)
    } else {
      setUseCustomChars(false)
      setCharSet(charSetOptions[selected] || charSetOptions.standard)
    }
  }

  const contactEmail = "cloudandclipboard@gmail.com"
  const buyMeACoffeeUrl = "https://buymeacoffee.com/cloudandclipboard"

  // ---------- Render ----------
  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: '#F9F6F0', color: '#2E2A28' }}>
      {/* Header with logo */}
      <div className="sticky top-0 z-10 backdrop-blur-md bg-white/40 border-b border-white/30 shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-4">
          <img src="/my-logo.png" alt="CharForge Logo" className="h-12 w-auto" />
          <div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight" style={{ color: '#3B4A3F' }}>CharForge</h1>
            <p className="text-xs md:text-sm mt-0.5" style={{ color: '#5C6E5E' }}>ASCII art studio • Game exports • Cloud sync • Custom fonts</p>
          </div>
        </div>
      </div>

      <div className="flex-1 max-w-7xl mx-auto w-full px-6 py-8 flex flex-col gap-8">
        {/* Auth card */}
        <div className="rounded-xl border border-[#E5D9CC] bg-white/90 backdrop-blur-sm p-4 flex flex-wrap justify-between items-center">
          {user ? (
            <div className="flex items-center gap-4 flex-wrap">
              <span>Welcome, {user.email}</span>
              <button onClick={signOut} className="text-sm bg-[#D96C4A] text-white px-3 py-1 rounded">Sign out</button>
              <button onClick={() => saveCurrentArt(prompt('Title for this ASCII art?'))} className="text-sm bg-[#3B4A3F] text-white px-3 py-1 rounded">💾 Save current to gallery</button>
            </div>
          ) : (
            <div className="flex gap-2 flex-wrap">
              <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} className="border rounded px-2 py-1" />
              <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} className="border rounded px-2 py-1" />
              <button onClick={handleAuth} disabled={loading} className="bg-[#D96C4A] text-white px-3 py-1 rounded">{authMode === 'signin' ? 'Sign In' : 'Sign Up'}</button>
              <button onClick={() => setAuthMode(authMode === 'signin' ? 'signup' : 'signin')} className="text-sm underline">{authMode === 'signin' ? 'Create account' : 'Sign in instead'}</button>
            </div>
          )}
        </div>

        {/* Drag & drop zone */}
        <div
          onDragEnter={(e) => handleDrag(e, true)}
          onDragOver={(e) => handleDrag(e, true)}
          onDragLeave={(e) => handleDrag(e, false)}
          onDrop={handleDrop}
          className={`rounded-2xl transition-all p-8 text-center shadow-md ${isDragging ? 'bg-[#F1E8DC] border-2 border-[#D96C4A]' : 'bg-white/90 border border-[#E5D9CC] hover:shadow-lg backdrop-blur-sm'}`}
        >
          <label htmlFor="file-input" className="flex flex-col items-center gap-3 cursor-pointer">
            <div className="p-4 rounded-full bg-[#D96C4A]/10 text-[#D96C4A]">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <div><span className="font-semibold" style={{ color: '#D96C4A' }}>Click or drag image(s)</span><p className="text-xs mt-1" style={{ color: '#6B5E55' }}>For animation, upload multiple images and enable batch mode + GIF export</p></div>
            <input id="file-input" type="file" accept="image/*" multiple onChange={handleFileUpload} className="hidden" />
          </label>
        </div>

        {/* Two columns */}
        <div className="flex flex-col lg:flex-row gap-8">
          {/* LEFT COLUMN – Controls */}
          <div className="lg:w-96 flex-shrink-0 space-y-6">
            <div className="flex justify-between items-center">
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input type="checkbox" checked={batchMode} onChange={(e) => setBatchMode(e.target.checked)} className="accent-[#D96C4A] w-4 h-4" />
                <span>Batch mode</span>
              </label>
              {batchMode && images.length > 1 && <button onClick={exportAsGIF} className="text-xs bg-[#D96C4A] text-white px-2 py-1 rounded">🎞️ Export as GIF</button>}
            </div>

            {batchMode && images.length > 0 && (
              <div className="bg-white/90 backdrop-blur-sm rounded-xl border border-[#E5D9CC] p-4 shadow-sm">
                <h3 className="text-sm font-semibold mb-3 flex justify-between"><span>Images ({images.length})</span><button onClick={batchExportAsZip} className="text-xs bg-[#D96C4A] text-white px-2 py-0.5 rounded">📦 Export all as ZIP</button></h3>
                <div className="flex flex-wrap gap-3 max-h-40 overflow-y-auto">
                  {images.map(img => (
                    <div key={img.id} className="relative group flex flex-col items-center">
                      <img src={img.url} alt="thumb" className="h-14 w-14 object-cover rounded-md cursor-pointer border-2" style={{ borderColor: activeImageId === img.id ? '#D96C4A' : '#E5D9CC' }} onClick={() => setActiveImageId(img.id)} />
                      <div className="absolute -top-2 -right-2 flex gap-1">
                        <button onClick={() => moveImage(img.id, 'up')} className="bg-white/80 text-gray-700 rounded-full w-5 h-5 text-xs">▲</button>
                        <button onClick={() => moveImage(img.id, 'down')} className="bg-white/80 text-gray-700 rounded-full w-5 h-5 text-xs">▼</button>
                        <button onClick={() => removeImage(img.id)} className="bg-red-500 text-white rounded-full w-5 h-5 text-xs">×</button>
                      </div>
                      <span className="text-[10px] truncate w-14 text-center mt-1">{img.name.slice(0,10)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="bg-white/90 backdrop-blur-sm rounded-xl border border-[#E5D9CC] p-4 shadow-sm">
              <h3 className="font-semibold mb-2">🔤 Custom Font</h3>
              <input type="file" accept=".ttf,.woff,.woff2,.otf" onChange={handleFontUpload} className="text-sm" />
              {fontMetrics && <p className="text-xs mt-1">Loaded: {fontMetrics.name}<br />Ratio: {fontMetrics.ratio.toFixed(2)}</p>}
            </div>

            <div className="bg-white/90 backdrop-blur-sm rounded-xl border border-[#E5D9CC] p-5 shadow-sm">
              <h3 className="font-semibold mb-3 flex items-center gap-2"><span className="text-[#D96C4A]">💾</span> Presets</h3>
              <div className="flex flex-wrap gap-2 mb-4 max-h-28 overflow-y-auto">
                {presets.map(p => (
                  <div key={p.name} className="flex items-center gap-0 rounded-full text-xs bg-[#F9F6F0] border border-[#E5D9CC]">
                    <button onClick={() => loadPreset(p.settings)} className="px-2 py-1 hover:bg-[#D96C4A]/10 rounded-l-full">{p.name}</button>
                    <button onClick={() => deletePreset(p.name)} className="px-1.5 py-1 hover:text-red-600 rounded-r-full">🗑️</button>
                  </div>
                ))}
                {cloudPresets.map(p => (
                  <div key={p.id} className="flex items-center gap-0 rounded-full text-xs bg-[#F9F6F0] border border-[#E5D9CC]">
                    <button onClick={() => loadPreset(p.settings)} className="px-2 py-1 hover:bg-[#D96C4A]/10 rounded-l-full">☁️ {p.name}</button>
                    <button onClick={() => deleteCloudPreset(p.id)} className="px-1.5 py-1 hover:text-red-600 rounded-r-full">🗑️</button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input type="text" value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="Preset name" className="flex-1 px-3 py-1.5 text-sm border rounded-lg" />
                <button onClick={savePreset} className="px-3 py-1.5 rounded-lg text-sm font-medium bg-[#D96C4A] text-white">Save</button>
              </div>
            </div>

            {images.length > 0 && (
              <div className="bg-white/90 backdrop-blur-sm rounded-xl border border-[#E5D9CC] p-5 shadow-sm space-y-4">
                <div className="flex justify-between items-center"><h2 className="font-semibold">Forge Controls</h2><button onClick={resetSettings} className="text-xs px-2 py-1 rounded-md border">Reset</button></div>
                <div><label>Width: {width}</label><input type="range" min="20" max="200" value={width} onChange={(e) => setWidth(parseInt(e.target.value))} className="w-full accent-[#D96C4A]" /></div>
                <div><div className="flex justify-between"><label>Vertical scale: {verticalScale.toFixed(2)}</label><button onClick={() => setVerticalScale(0.45)} className="text-xs bg-gray-200 px-1">Reset</button></div><input type="range" min="0.30" max="0.70" step="0.01" value={verticalScale} onChange={(e) => setVerticalScale(parseFloat(e.target.value))} className="w-full accent-[#D96C4A]" /></div>

                <div>
                  <label>Character set</label>
                  <select
                    value={useCustomChars ? 'custom' : Object.keys(charSetOptions).find(key => charSetOptions[key] === charSet) || 'standard'}
                    onChange={handleCharSetSelect}
                    className="w-full p-2 rounded-lg border"
                  >
                    <option value="standard">Standard (@%#*+=-:. )</option>
                    <option value="blocks">Blocks (█▓▒░ )</option>
                    <option value="simple">Simple ( .:;+=x%#@)</option>
                    <option value="braille">Braille (⣿⣶⣧⣷...)</option>
                    <option value="shades">Shades (▓▒░█ )</option>
                    <option value="detailed">Detailed (@#$%&WX890B...)</option>
                    <option value="artistic">Artistic (█✶☯❖◆◇...)</option>
                    <option value="minimal">Minimal ( .!|/\\-~+=*%#@)</option>
                    <option value="custom">✏️ Custom (type below)</option>
                  </select>
                </div>

                {useCustomChars && <input type="text" value={customChars} onChange={(e) => setCustomChars(e.target.value)} className="w-full p-2 border rounded" />}
                <div><label>Dithering</label><select value={ditherMethod} onChange={(e) => setDitherMethod(e.target.value)} className="w-full p-2 rounded-lg border"><option>none</option><option>floyd</option><option>atkinson</option></select></div>
                <div><label>Brightness: {brightness}</label><input type="range" min="-100" max="100" value={brightness} onChange={(e) => setBrightness(parseInt(e.target.value))} className="w-full accent-[#D96C4A]" /></div>
                <div><label>Contrast: {contrast}%</label><input type="range" min="0" max="200" value={contrast} onChange={(e) => setContrast(parseInt(e.target.value))} className="w-full accent-[#D96C4A]" /></div>
                <div className="grid grid-cols-2 gap-2"><div><label>Text color</label><input type="color" value={textColor} onChange={(e) => setTextColor(e.target.value)} className="w-full h-9" /></div><div><label>Background</label><input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} className="w-full h-9" /></div></div>
                <div><label>PNG scale: {pngScale}x</label><input type="range" min="1" max="4" step="1" value={pngScale} onChange={(e) => setPngScale(parseInt(e.target.value))} className="w-full accent-[#D96C4A]" /></div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="transparentBg"
                    checked={transparentBg}
                    onChange={(e) => setTransparentBg(e.target.checked)}
                    className="accent-[#D96C4A] w-4 h-4"
                  />
                  <label htmlFor="transparentBg" className="text-sm">Transparent PNG background (overrides background color)</label>
                </div>

                <div className="flex items-center gap-2"><input type="checkbox" id="invert" checked={invert} onChange={(e) => setInvert(e.target.checked)} className="accent-[#D96C4A]" /><label htmlFor="invert">Invert</label></div>
              </div>
            )}
          </div>

          {/* RIGHT COLUMN – Output and Gallery */}
          <div className="flex-1 min-w-0">
            {currentAscii ? (
              <div className="sticky top-28">
                <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
                  <div><h2 className="text-xl font-semibold">✨ Live ASCII</h2>{dims.width > 0 && <p className="text-xs">Dimensions: {dims.width} × {dims.height}</p>}</div>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={exportAsPng} className="px-2 py-1 rounded bg-[#D96C4A] text-white text-sm">PNG</button>
                    <button onClick={exportAsPdf} className="px-2 py-1 rounded bg-[#D96C4A] text-white text-sm">PDF</button>
                    <button onClick={exportAsJSON} className="px-2 py-1 rounded border text-sm">JSON</button>
                    <button onClick={exportAsCSV} className="px-2 py-1 rounded border text-sm">CSV</button>
                    <button onClick={exportAsTMX} className="px-2 py-1 rounded border text-sm">TMX</button>
                    <button onClick={exportAsLua} className="px-2 py-1 rounded border text-sm">Lua</button>
                    <button onClick={() => { navigator.clipboard.writeText(currentAscii); alert('Copied!'); }} className="px-2 py-1 rounded border text-sm">Copy</button>
                    <button onClick={() => { const blob = new Blob([currentAscii], {type: 'text/plain'}); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `ascii-${dims.width}x${dims.height}.txt`; link.click(); }} className="px-2 py-1 rounded border text-sm">TXT</button>
                  </div>
                </div>
                <div ref={asciiRef} className="rounded-xl border shadow-inner p-5 overflow-auto max-h-[calc(100vh-250px)]" style={{ backgroundColor: bgColor, color: textColor, borderColor: '#E5D9CC' }}>
                  <pre className="font-mono text-sm leading-tight whitespace-pre">{currentAscii}</pre>
                </div>

                {/* Gallery Section */}
                {user && cloudArts.length > 0 && (
                  <div className="mt-6 border-t border-[#E5D9CC] pt-4">
                    <h3 className="font-semibold mb-2 flex items-center gap-2">🖼️ Your Gallery ({cloudArts.length})</h3>
                    <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                      {cloudArts.map(art => (
                        <div key={art.id} className="bg-white/80 rounded p-2 text-sm border border-[#E5D9CC] flex justify-between items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="font-medium truncate">{art.title || 'Untitled'}</div>
                            <div className="text-xs text-gray-500">{new Date(art.created_at).toLocaleString()}</div>
                            <pre className="text-xs mt-1 font-mono bg-gray-50 p-1 rounded truncate max-h-12 overflow-hidden">{art.content.substring(0, 80)}...</pre>
                          </div>
                          <div className="flex gap-1 flex-shrink-0">
                            <button
                              onClick={() => {
                                setModalTitle(art.title || 'ASCII Art');
                                setModalContent(art.content);
                                setModalOpen(true);
                              }}
                              className="text-xs bg-[#D96C4A] text-white px-2 py-1 rounded hover:opacity-80"
                            >
                              View
                            </button>
                            <button
                              onClick={async () => {
                                if (confirm('Delete this saved art?')) {
                                  const { error } = await supabase.from('ascii_arts').delete().eq('id', art.id);
                                  if (error) alert(error.message);
                                  else loadGallery();
                                }
                              }}
                              className="text-xs bg-gray-300 text-gray-700 px-2 py-1 rounded hover:bg-red-400 hover:text-white"
                            >
                              🗑️
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-center h-80 rounded-xl border-2 border-dashed border-[#E5D9CC] bg-white/50">
                <p className="text-center">Upload an image to start</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="text-center py-6 border-t mt-8 backdrop-blur-md bg-white/30">
        <div className="max-w-7xl mx-auto px-6">
          <p className="text-sm mb-2">CharForge — local processing, cloud optional. Game exports: TMX, Lua, JSON, CSV.</p>
          <div className="flex flex-wrap justify-center gap-5 text-sm">
            <button onClick={() => { navigator.clipboard.writeText(contactEmail); alert(`Copied: ${contactEmail}`); }} className="hover:underline flex items-center gap-1" style={{ color: '#D96C4A' }}>📧 Contact</button>
            <a href={buyMeACoffeeUrl} target="_blank" rel="noopener noreferrer" className="hover:underline flex items-center gap-1" style={{ color: '#D96C4A' }}>☕ Buy me a coffee</a>
          </div>
        </div>
      </footer>

      {/* Modal for viewing full ASCII art */}
      {modalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 backdrop-blur-sm" onClick={() => setModalOpen(false)}>
          <div className="bg-white rounded-xl max-w-3xl w-full max-h-[80vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center p-4 border-b">
              <h3 className="font-semibold text-lg">{modalTitle}</h3>
              <button onClick={() => setModalOpen(false)} className="text-gray-500 hover:text-gray-700 text-xl">✕</button>
            </div>
            <div className="p-4 overflow-auto flex-1">
              <pre className="font-mono text-sm whitespace-pre-wrap bg-gray-50 p-3 rounded border">{modalContent}</pre>
            </div>
            <div className="p-4 border-t flex justify-end gap-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(modalContent);
                  alert('Copied to clipboard!');
                }}
                className="bg-[#D96C4A] text-white px-3 py-1 rounded text-sm"
              >
                Copy to clipboard
              </button>
              <button onClick={() => setModalOpen(false)} className="border px-3 py-1 rounded text-sm">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App