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
// gemini-3.5-flash is currently our most stable functional model for this workflow
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent"

const diarizeCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-extension-key',
}

/**
 * Delay function for retries
 */
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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

    // 1. Fetch Audio
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

    // 3. Prepare Payload
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
            text: `You are a professional Swedish transcription and diarization expert.
CORE MANDATE: The provided audio file is your ONLY source of truth.

Instructions:
1. Provide a clean, accurate, and diarized transcript in Swedish.
2. Use ASR text ONLY for spelling technical terms if they match the audio.
3. Always start with [lang:sv].
4. Identify speakers as [SPEAKER 1:], [SPEAKER 2:], etc.
5. Return ONLY the diarized transcription text.

ASR Reference: ${asr_text || "[None provided]"}`
          }
        ]
      }],
      generationConfig: {
        temperature: 0.1
      }
    }

    // 4. Call Gemini with Retry Logic
    console.log(`[${requestId}] Calling Gemini 3.5 Flash...`)
    let retryCount = 0
    const maxRetries = 3
    let responseData: any = null

    while (retryCount <= maxRetries) {
      const startGemini = Date.now()
      const response = await fetch(GEMINI_API_URL, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey 
        },
        body: JSON.stringify(payload)
      })

      responseData = await response.json()
      console.log(`[${requestId}] Attempt ${retryCount + 1}: Gemini responded in ${Date.now() - startGemini}ms`)

      if (responseData.error) {
        const errCode = responseData.error.code
        // Retry on 503 (Unavailable) and 429 (Rate Limit)
        if ((errCode === 503 || errCode === 429) && retryCount < maxRetries) {
          console.warn(`[${requestId}] Gemini error ${errCode}. Retrying in ${Math.pow(2, retryCount)}s...`)
          await delay(Math.pow(2, retryCount) * 1000)
          retryCount++
          continue
        }
        console.error(`[${requestId}] Gemini Final Error:`, responseData.error)
        throw new Error(`Gemini Error: ${responseData.error.message}`)
      }
      break // Success
    }

    const diarizedText = responseData.candidates?.[0]?.content?.parts?.[0]?.text || ""

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
