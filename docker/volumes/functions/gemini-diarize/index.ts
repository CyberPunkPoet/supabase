/**
 * High-speed, dependency-free Base64 encoder for Deno.
 * Safe for large audio files.
 */
function encodeBase64(uint8: Uint8Array): string {
  let result = "";
  const len = uint8.length;
  // Use 16KB chunks to avoid stack limits while maintaining speed
  for (let i = 0; i < len; i += 16383) {
    result += String.fromCharCode.apply(null, uint8.subarray(i, i + 16383) as any);
  }
  return btoa(result);
}

const SYSTEM_GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')
const INTERNAL_EXTENSION_KEY = Deno.env.get('INTERNAL_EXTENSION_KEY')
// Using gemini-3.5-flash as the baseline 3.x model for stability
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent"

const diarizeCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-extension-key',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: diarizeCorsHeaders })
  }

  const requestId = Math.random().toString(36).substring(7)
  console.log(`[${requestId}] Request started`)

  try {
    const extensionKey = req.headers.get('x-extension-key')
    if (!extensionKey || extensionKey !== INTERNAL_EXTENSION_KEY) {
       return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...diarizeCorsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { asr_text, audio_url } = await req.json()
    if (!audio_url) throw new Error('audio_url is required')

    const apiKey = SYSTEM_GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY not set')

    // 1. Fetch
    const startFetch = Date.now()
    const audioResponse = await fetch(audio_url)
    if (!audioResponse.ok) throw new Error(`Fetch failed: ${audioResponse.statusText}`)
    const audioBuffer = await audioResponse.arrayBuffer()
    const uint8Array = new Uint8Array(audioBuffer)
    console.log(`[${requestId}] Audio fetched: ${uint8Array.length} bytes in ${Date.now() - startFetch}ms`)

    // 2. Encode
    const startEncode = Date.now()
    const base64Audio = encodeBase64(uint8Array)
    console.log(`[${requestId}] Encoded in ${Date.now() - startEncode}ms`)

    // 3. Basics-only Payload (matching user curl structure)
    const mimeType = audioResponse.headers.get('content-type') === 'application/octet-stream' 
      ? 'audio/mpeg' 
      : (audioResponse.headers.get('content-type') || 'audio/mpeg')

    const payload = {
      contents: [{
        parts: [
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Audio
            }
          },
          {
            text: `Diarize this Swedish audio. Start with [lang:sv]. Use [SPEAKER 1:], [SPEAKER 2:], etc. ASR: ${asr_text || ""}`
          }
        ]
      }]
    }

    // 4. Call (Using Header Auth)
    console.log(`[${requestId}] Calling Gemini 3.5 Flash...`)
    const startGemini = Date.now()
    const response = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey 
      },
      body: JSON.stringify(payload)
    })

    const data = await response.json()
    console.log(`[${requestId}] Gemini responded in ${Date.now() - startGemini}ms`)

    if (data.error) {
      console.error(`[${requestId}] Gemini Error:`, data.error)
      throw new Error(`Gemini Error: ${data.error.message}`)
    }

    const diarizedText = data.candidates?.[0]?.content?.parts?.[0]?.text || ""

    return new Response(JSON.stringify({ diarizedText }), {
      headers: { ...diarizeCorsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error(`[${requestId}] Fail:`, error)
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...diarizeCorsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
