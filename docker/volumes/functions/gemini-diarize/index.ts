import { encode } from "https://deno.land/std@0.203.0/encoding/base64.ts"

const SYSTEM_GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')
const INTERNAL_EXTENSION_KEY = Deno.env.get('INTERNAL_EXTENSION_KEY')
// Use the 3.5-flash-lite-latest alias as per project policy
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite-latest:generateContent"

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
    let systemInstruction = {
      parts: [{
        text: `You are a professional Swedish transcription and diarization expert.
Your goal is to provide a clean, accurate, and diarized transcript based on the provided audio.

CORE RULES:
1. The AUDIO is the primary source of truth. Listen to it carefully.
2. If ASR text is provided, use it as a reference for spelling and technical terms, but OVERRIDE it if the audio says something different.
3. If no ASR text is provided, perform a complete transcription from the audio.
4. Always start the response with the tag [lang:sv].
5. Identify speakers using [SPEAKER X:] tags (e.g., [SPEAKER 1:], [SPEAKER 2:]).
6. Return ONLY the diarized transcription text. Do not include meta-commentary about the binary data or file headers.
7. If you hear someone speaking, transcribe it. If you hear silence, ignore it.`
      }]
    }

    if (audio_url) {
      console.log(`[Info] Fetching audio from: ${audio_url.substring(0, 60)}...`)
      const audioResponse = await fetch(audio_url)
      
      if (!audioResponse.ok) {
        throw new Error(`Failed to fetch audio: ${audioResponse.statusText}`)
      }

      const audioBuffer = await audioResponse.arrayBuffer()
      const uint8Array = new Uint8Array(audioBuffer)
      const base64Audio = encode(uint8Array)
      const mimeType = audioResponse.headers.get('content-type') || 'audio/mpeg'
      console.log(`[Info] Detected MIME type: ${mimeType}`)

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
            text: `Please transcribe and diarize the attached audio file. 
Reference ASR text (may be empty or inaccurate): 
${asrContent}`
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

    console.log("Calling Gemini 3.5 Flash Lite (Multi-modal)...")

    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        contents,
        system_instruction: systemInstruction,
        generationConfig: {
          temperature: 0.1, // Keep it grounded for transcription
        }
      })
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
