# -*- coding: utf-8 -*-
import os
import requests
import streamlit as st

st.set_page_config(
    page_title="J.A.R.V.I.S. 360",
    page_icon="⚡",
    layout="wide"
)

# Inicializacao de Historico
if "messages" not in st.session_state:
    st.session_state.messages = [
        {"role": "assistant", "content": "J.A.R.V.I.S. pronto. Arquitetura sincronizada via barramento direto."}
    ]

# Leitura de chaves
groq_key = os.environ.get("GROQ_API_KEY", "").strip()
gemini_key = (os.environ.get("GEMINI_API_KEY", "") or os.environ.get("GOOGLE_API_KEY", "")).strip()

st.title("⚡ J.A.R.V.I.S. 360 - Central de Controle")

with st.sidebar:
    st.header("⚙️ Status da Conexao")
    st.markdown(f"- **Groq (Llama-3.1):** {'🟢 Ativo' if (groq_key and not groq_key.startswith('gsk_sua')) else '⚪ Inativo'}")
    st.markdown(f"- **Gemini (Flash):** {'🟢 Ativo' if (gemini_key and not gemini_key.startswith('AIzaSy_sua')) else '⚪ Inativo'}")
    st.markdown("- **Motor Local:** 🟢 Standby (CPU/AVX)")
    st.markdown("---")
    if st.button("Limpar Conversa"):
        st.session_state.messages = []
        st.rerun()

def call_groq_rest(prompt: str, key: str) -> str:
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": "llama-3.1-8b-instant",
        "messages": [
            {"role": "system", "content": "Voce e o JARVIS. Responda em portugues com clareza tecnica e brevidade."},
            {"role": "user", "content": prompt}
        ],
        "max_tokens": 1024,
        "temperature": 0.5
    }
    r = requests.post(url, json=payload, headers=headers, timeout=15)
    if r.status_code == 200:
        return r.json()["choices"][0]["message"]["content"].strip()
    return None

def call_gemini_rest(prompt: str, key: str) -> str:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={key}"
    headers = {"Content-Type": "application/json"}
    payload = {
        "contents": [
            {
                "parts": [{"text": prompt}]
            }
        ],
        "generationConfig": {
            "maxOutputTokens": 1024,
            "temperature": 0.5
        }
    }
    r = requests.post(url, json=payload, headers=headers, timeout=15)
    if r.status_code == 200:
        data = r.json()
        return data["candidates"][0]["content"]["parts"][0]["text"].strip()
    return None

def generate_response(prompt: str) -> str:
    # 1. Rota Groq REST (Zero dependencia de SDK assincrono)
    if groq_key and not groq_key.startswith("gsk_sua"):
        try:
            res = call_groq_rest(prompt, groq_key)
            if res:
                return res
        except Exception:
            pass

    # 2. Rota Gemini REST
    if gemini_key and not gemini_key.startswith("AIzaSy_sua"):
        try:
            res = call_gemini_rest(prompt, gemini_key)
            if res:
                return res
        except Exception:
            pass

    # 3. Fallback Local Seguro via GPT4All
    try:
        from gpt4all import GPT4All
        model = GPT4All("orca-mini-3b-gguf2-q4_0.gguf", device="cpu", allow_download=False)
        with model.chat_session():
            return model.generate(prompt, max_tokens=256).strip()
    except Exception as e:
        return f"[Aviso]: Todos os backends estao offline ou sem credencial valida. Detalhe: {e}"

# Renderizar Mensagens
for msg in st.session_state.messages:
    with st.chat_message(msg["role"]):
        st.markdown(msg["content"])

user_input = st.chat_input("Digite um comando ou mensagem para o JARVIS...")
if user_input:
    st.session_state.messages.append({"role": "user", "content": user_input})
    with st.chat_message("user"):
        st.markdown(user_input)

    with st.chat_message("assistant"):
        with st.spinner("Processando..."):
            ans = generate_response(user_input)
            st.markdown(ans)
            st.session_state.messages.append({"role": "assistant", "content": ans})
