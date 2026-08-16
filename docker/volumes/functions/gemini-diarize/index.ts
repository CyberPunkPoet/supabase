import { encode } from "https://deno.land/std@0.203.0/encoding/base64.ts"

const SYSTEM_GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')
const INTERNAL_EXTENSION_KEY = Deno.env.get('INTERNAL_EXTENSION_KEY')
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent"

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
    const asrContent = asr_text || "[No ASR provided]"

    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'No Gemini API key configured on VPS' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    let contents: any[] = []

    if (audio_url) {
      console.log(`Fetching audio from: ${audio_url.substring(0, 50)}...`)
      const audioResponse = await fetch(audio_url)
      
      if (!audioResponse.ok) {
        throw new Error(`Failed to fetch audio: ${audioResponse.statusText}`)
      }

      const audioBuffer = await audioResponse.arrayBuffer()
      const uint8Array = new Uint8Array(audioBuffer)
      const base64Audio = encode(uint8Array)
      const mimeType = audioResponse.headers.get('content-type') || 'audio/mpeg'

      contents = [{
        role: 'user',
        parts: [
          {
            text: `You are a professional Swedish transcription assistant. Your goal is to perform an accurate diarization and transcription.
CRITICAL: The provided audio file is your PRIMARY SOURCE OF TRUTH. 

Context:
- You are provided with a raw ASR text transcript (which may be empty, incomplete, or inaccurate).
- You are provided with the actual audio of the conversation.

Instructions:
1. Listen carefully to the audio. It is the absolute reference.
2. If the ASR text is provided, use it as a helpful guide for spelling names or technical terms, but OVERRIDE it completely if the audio differs.
3. If the ASR text is empty or missing, perform a full transcription and diarization from the audio from scratch.
4. Always start the output with [lang:sv].
5. Identify speakers clearly using [SPEAKER X:] tags (e.g., [SPEAKER 1:], [SPEAKER 2:]).
6. Ensure the flow is natural and captures all dialogue heard in the audio.
7. Return ONLY the final diarized and transcribed text.

ASR Text (Reference only):
${asrContent}`
          },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Audio
            }
          }
        ]
      }]
    } else {
      contents = [{
        role: 'user',
        parts: [{ 
          text: `You are a professional Swedish transcription assistant. Your goal is to take raw ASR text and perform accurate diarization. 
Rules:
1. Always start with [lang:sv].
2. Identify speakers as [SPEAKER 1:], [SPEAKER 2:], etc.
3. If unsure, use [unsure: text].
4. Maintain the verbatim transcription unless there are obvious ASR errors in Swedish grammar.
5. Return ONLY the diarized text.

Input ASR: ${asr_text}`
        }]
      }]
    }

    console.log("Calling Gemini API (Multi-modal)...")

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
