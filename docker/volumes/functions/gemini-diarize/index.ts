// Dependency-free Base64 encoder to fix worker boot errors
function encodeBase64(uint8: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < uint8.byteLength; i++) {
    bin += String.fromCharCode(uint8[i]);
  }
  return btoa(bin);
}

const SYSTEM_GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')
const INTERNAL_EXTENSION_KEY = Deno.env.get('INTERNAL_EXTENSION_KEY')
// Using gemini-3.6-flash (latest)
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-extension-key',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const extensionKey = req.headers.get('x-extension-key')
    const authHeader = req.headers.get('Authorization')

    const isExtensionAuthenticated = extensionKey && extensionKey === INTERNAL_EXTENSION_KEY

    // Verify either our internal extension key or an authorized bearer header
    if (!isExtensionAuthenticated && !authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Extension not authenticated' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { asr_text, audio_url } = await req.json()

    if (!asr_text && !audio_url) {
      return new Response(JSON.stringify({ error: 'No transcription text or audio URL provided' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const apiKey = SYSTEM_GEMINI_API_KEY
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'No Gemini API key configured on VPS' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const asrContent = asr_text || "[No ASR text provided]"
    let contents: any[] = []

    if (audio_url) {
      console.log(`[Info] Fetching audio from: ${audio_url.substring(0, 60)}...`)
      const audioResponse = await fetch(audio_url)
      
      if (!audioResponse.ok) {
        throw new Error(`Failed to fetch audio: ${audioResponse.statusText}`)
      }

      const audioBuffer = await audioResponse.arrayBuffer()
      const uint8Array = new Uint8Array(audioBuffer)
      const base64Audio = encodeBase64(uint8Array)
      
      console.log(`[Info] Audio fetched. Buffer size: ${uint8Array.length} bytes. Base64 length: ${base64Audio.length}`)
      
      let mimeType = audioResponse.headers.get('content-type') || 'audio/mpeg'
      if (mimeType === 'application/octet-stream') {
        mimeType = 'audio/mpeg'
      }
      
      console.log(`[Info] Detected/Forced MIME type: ${mimeType}`)

      // Simplified payload for Gemini 3.x to resolve 500 errors
      contents = [{
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
CORE MANDATE: The provided audio file is your ONLY source of truth.

Instructions:
1. Provide a clean, accurate, and diarized transcript in Swedish.
2. Use ASR text ONLY for spelling technical terms.
3. Always start with [lang:sv].
4. Identify speakers as [SPEAKER 1:], [SPEAKER 2:], etc.
5. Return ONLY the diarized transcription text.

ASR Reference: ${asrContent}`
          }
        ]
      }]
    } else {
      contents = [{
        role: 'user',
        parts: [{ 
          text: `Take the following raw ASR text and perform accurate diarization into [SPEAKER 1:], [SPEAKER 2:], etc.
Always start with [lang:sv].

ASR Text:
${asr_text}`
        }]
      }]
    }

    console.log("Calling Gemini 3.6 Flash (Multi-modal)...")

    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contents })
    })

    const data = await response.json()

    if (data.error) {
      console.error("Gemini Error:", data.error)
      throw new Error(`Gemini API Error: ${data.error.message}`)
    }

    const diarizedText = data.candidates?.[0]?.content?.parts?.[0]?.text || ""

    return new Response(JSON.stringify({ diarizedText }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error("Diarize Function Error:", error)
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
