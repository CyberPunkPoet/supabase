/**
 * Faster, stack-safe Base64 encoder for Deno Edge Functions.
 * Avoids String.fromCharCode.apply stack limits and resolves 504 timeouts.
 */
function encodeBase64(uint8: Uint8Array): string {
  const map = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  const len = uint8.length;
  for (let i = 0; i < len; i += 3) {
    const b1 = uint8[i];
    const b2 = i + 1 < len ? uint8[i + 1] : NaN;
    const b3 = i + 2 < len ? uint8[i + 2] : NaN;

    result += map.charAt(b1 >> 2);
    result += map.charAt(((b1 & 3) << 4) | (b2 >> 4));
    if (isNaN(b2)) {
      result += "==";
    } else {
      result += map.charAt(((b2 & 15) << 2) | (b3 >> 6));
      result += isNaN(b3) ? "=" : map.charAt(b3 & 63);
    }
  }
  return result;
}

const SYSTEM_GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')
const INTERNAL_EXTENSION_KEY = Deno.env.get('INTERNAL_EXTENSION_KEY')
// Using gemini-3.7-flash (latest)
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent"

const diarizeCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-extension-key',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: diarizeCorsHeaders })
  }

  const requestId = Math.random().toString(36).substring(7)
  console.log(`[${requestId}] Diarize request started`)

  try {
    const extensionKey = req.headers.get('x-extension-key')
    if (!extensionKey || extensionKey !== INTERNAL_EXTENSION_KEY) {
       return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...diarizeCorsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { asr_text, audio_url } = await req.json()

    if (!audio_url) {
      return new Response(JSON.stringify({ error: 'audio_url is required' }), {
        status: 400,
        headers: { ...diarizeCorsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const apiKey = SYSTEM_GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY not configured')

    const asrContent = asr_text || "[No ASR text provided]"

    // 1. Fetch Audio
    const startFetch = Date.now()
    const audioResponse = await fetch(audio_url)
    if (!audioResponse.ok) throw new Error(`Failed to fetch audio: ${audioResponse.statusText}`)
    const audioBuffer = await audioResponse.arrayBuffer()
    const uint8Array = new Uint8Array(audioBuffer)
    console.log(`[${requestId}] Audio fetched in ${Date.now() - startFetch}ms. Size: ${uint8Array.length} bytes`)

    // 2. Encode Base64
    const startEncode = Date.now()
    const base64Audio = encodeBase64(uint8Array)
    console.log(`[${requestId}] Base64 encoded in ${Date.now() - startEncode}ms`)

    // 3. Prepare Payload
    let mimeType = audioResponse.headers.get('content-type') || 'audio/mpeg'
    if (mimeType === 'application/octet-stream') mimeType = 'audio/mpeg'

    const contents = [{
      role: 'user',
      parts: [
        {
          inline_data: {
            mime_type: mimeType,
            data: base64Audio
          }
        },
        {
          text: `You are a professional Swedish transcription and diarization expert.
Instructions:
1. Provide an accurate, diarized transcript in Swedish.
2. Start with [lang:sv].
3. Speakers: [SPEAKER 1:], [SPEAKER 2:], etc.
4. Source: The attached audio. ASR text is reference only: ${asrContent}`
        }
      ]
    }]

    // 4. Call Gemini
    console.log(`[${requestId}] Calling Gemini 3.7 Flash...`)
    const startGemini = Date.now()
    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        contents,
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4096 // Ensure enough space for full transcript
        }
      })
    })

    const data = await response.json()
    console.log(`[${requestId}] Gemini responded in ${Date.now() - startGemini}ms`)

    if (data.error) {
      console.error(`[${requestId}] Gemini Error:`, data.error)
      throw new Error(`Gemini API Error: ${data.error.message}`)
    }

    const diarizedText = data.candidates?.[0]?.content?.parts?.[0]?.text || ""

    return new Response(JSON.stringify({ diarizedText }), {
      headers: { ...diarizeCorsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error(`[${requestId}] Error:`, error)
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...diarizeCorsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
