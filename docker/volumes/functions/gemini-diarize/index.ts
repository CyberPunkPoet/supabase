/// <reference lib="deno.ns" />

const SYSTEM_GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')
const INTERNAL_EXTENSION_KEY = Deno.env.get('INTERNAL_EXTENSION_KEY')

const diarizeCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-extension-key',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: diarizeCorsHeaders })
  }

  try {
    const extensionKey = req.headers.get('x-extension-key')
    const authHeader = req.headers.get('Authorization')

    const isExtensionAuthenticated = extensionKey && extensionKey === INTERNAL_EXTENSION_KEY

    // Verify either our internal extension key or an authorized bearer header
    if (!isExtensionAuthenticated && !authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Extension not authenticated' }), {
        status: 401,
        headers: { ...diarizeCorsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { action, asr_text, audio, mime_type, system_prompt, model } = await req.json()

    let apiKey = SYSTEM_GEMINI_API_KEY

    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'No Gemini API key configured on VPS (GEMINI_API_KEY environment variable is missing).' }), {
        status: 400,
        headers: { ...diarizeCorsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Action: List Models
    if (action === 'list_models') {
      console.log("Fetching available models from Gemini...")
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`)
      const data = await response.json()
      
      if (data.error) {
        throw new Error(`Gemini API Error: ${data.error.message}`)
      }

      // Filter for models that support content generation
      const models = (data.models || [])
        .filter((m: any) => m.supportedGenerationMethods.includes('generateContent'))
        .map((m: any) => ({
          name: m.name.replace('models/', ''),
          displayName: m.displayName,
          description: m.description
        }))

      return new Response(JSON.stringify({ models }), {
        headers: { ...diarizeCorsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Default Action: Diarize
    if (!asr_text && !audio) {
      return new Response(JSON.stringify({ error: 'No transcription text or audio provided' }), {
        status: 400,
        headers: { ...diarizeCorsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const defaultSystemPrompt = `You are a professional Swedish transcription assistant. Your goal is to take raw ASR text and perform accurate diarization. 
Rules:
1. Always start with [lang:sv].
2. Identify speakers as [SPEAKER 1:], [SPEAKER 2:], etc.
3. If unsure, use [unsure: text].
4. Maintain the verbatim transcription unless there are obvious ASR errors in Swedish grammar.
5. Return ONLY the diarized text.

Input ASR: ${asr_text}`

    const finalSystemPrompt = system_prompt || defaultSystemPrompt;

    const geminiParts: any[] = [{ text: finalSystemPrompt }];

    if (audio) {
      geminiParts.push({
        inline_data: {
          mime_type: mime_type || "audio/mpeg",
          data: audio
        }
      });
    }

    if (audio && asr_text) {
        geminiParts.push({ text: `Raw ASR Text for reference:\n${asr_text}` });
    }

    const selectedModel = model || "gemini-flash-lite-latest";
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent`;

    console.log(`Calling Gemini API (Multimodal - ${selectedModel})...`)

    const response = await fetch(`${apiUrl}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: geminiParts
        }]
      })
    })

    const data = await response.json()

    if (data.error) {
      console.error("Gemini Error:", data.error)
      throw new Error(`Gemini API Error: ${data.error.message}`)
    }

    const diarizedText = data.candidates?.[0]?.content?.parts?.[0]?.text || ""

    return new Response(JSON.stringify({ diarizedText }), {
      headers: { ...diarizeCorsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error("Diarize Function Error:", error)
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...diarizeCorsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
