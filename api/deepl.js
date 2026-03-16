export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = process.env.DEEPL_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "DeepL API key non configurata" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const isFree = apiKey.endsWith(":fx");
    const deeplUrl = isFree
      ? "https://api-free.deepl.com/v2/translate"
      : "https://api.deepl.com/v2/translate";

    const response = await fetch(deeplUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "DeepL-Auth-Key " + apiKey,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: "Errore DeepL: " + error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

