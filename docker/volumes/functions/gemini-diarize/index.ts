import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7"

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ""
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ""
const SYSTEM_GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')
const INTERNAL_EXTENSION_KEY = Deno.env.get('INTERNAL_EXTENSION_KEY') // Shared secret between extension and VPS
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-lite:generateContent"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-extension-key',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const extensionKey = req.headers.get('x-extension-key')
    
    // Auth Strategy 1: User JWT
    const authHeader = req.headers.get('Authorization')
    let user = null
    
    if (authHeader) {
      const { data: { user: authUser } } = await supabaseClient.auth.getUser(authHeader.replace('Bearer ', ''))
      user = authUser
    }

    // Auth Strategy 2: Internal Extension Key (Fallback for background scripts)
    const isExtensionAuthenticated = extensionKey && extensionKey === INTERNAL_EXTENSION_KEY

    if (!user && !isExtensionAuthenticated) {
      return new Response(JSON.stringify({ error: 'Unauthorized: Extension not authenticated' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { asr_text } = await req.json()
    
    // Fetch key logic: 
    // 1. If User exists, check their ai_credentials first.
    // 2. Fallback to System Key if User has no key OR if this is an Extension-Key-only request.
    
    let apiKey = SYSTEM_GEMINI_API_KEY

    if (user) {
      const { data: credential } = await supabaseClient
        .from('ai_credentials')
        .select('api_key')
        .eq('user_id', user.id)
        .eq('provider', 'gemini')
        .single()
      
      if (credential?.api_key) apiKey = credential.api_key
    }

    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'No Gemini API key found for user. Please add it in settings.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const prompt = `You are a professional Swedish transcription assistant. Your goal is to take raw ASR text and perform accurate diarization. 
Rules:
1. Always start with [lang:sv].
2. Identify speakers as [SPEAKER 1:], [SPEAKER 2:], etc.
3. If unsure, use [unsure: text].
4. Maintain the verbatim transcription unless there are obvious ASR errors in Swedish grammar.
5. Return ONLY the diarized text.

Input ASR: ${asr_text}`

    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }]
      })
    })

    const data = await response.json()
    
    if (data.error) {
        throw new Error(`Gemini API Error: ${data.error.message}`)
    }

    const diarizedText = data.candidates[0].content.parts[0].text

    return new Response(JSON.stringify({ diarizedText }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
