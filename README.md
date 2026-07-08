<p align="center">
  <img src="media/logo.png" width="128" height="128" alt="DevLingo Logo" />
</p>

# DevLingo 🏆 - Seu Coach de Inglês no VS Code

O **DevLingo** é uma extensão inteligente para o VS Code que atua como seu coach de inglês pessoal durante o expediente. Ele ajuda desenvolvedores a traduzirem códigos, documentações e mensagens, ensina pronúncias do dia a dia da área de TI e acompanha a sua evolução diária por meio de gamificação e testes interativos.

---

## 🚀 Principais Recursos

### 1. Tradução Inteligente com Coach de IA (Gemini)
* **Connected Speech**: Descubra como as palavras se conectam na pronúncia natural falada por nativos (ex: *"Translation test"* vira *"Translayshun_test"*).
* **Dicas de TI**: Receba explicações gramaticais e de contexto técnico focadas na área de desenvolvimento, traduzidas em ambos os idiomas (Inglês e Português).
* **Cache Inteligente**: Suas traduções anteriores são salvas localmente para carregar em 0ms (offline), economizando dados e requisições da API do Gemini.

![Dicas do Coach e Connected Speech](media/hover.png)

---

### 2. Painel de Desafios e Evolução Diária (Desafios 🏆)
Acompanhe seu progresso diretamente pela barra lateral:
* **🔥 Streak Diária**: Dias consecutivos em que você praticou inglês.
* **🧠 Vocabulário**: Total de termos já traduzidos.
* **✅ Aprendidos**: Quantidade de termos fixados (marcados no histórico ou validados no Quiz).
* **🎯 Taxa de Acerto**: Estatística percentual de acertos nas perguntas do Quiz.
* **Quiz Interativo**: Desafios de 3 perguntas geradas dinamicamente com base nas expressões que você traduziu na extensão!

![Painel de Desafios](media/challenges.png)

---

### 3. Tradutor, Expressões e Checklist de Vocabulário
* **Tradutor Dinâmico**: Tradução rápida bidirecional diretamente no painel.
* **Expressões Úteis**: Guia prático de expressões comuns no dia a dia dev (Daily standups, Pull Requests, Code Reviews, Bugs, etc.).
* **Checklist de Vocabulário**: Marque as frases do histórico como "aprendidas" e revise suas pronúncias a qualquer hora.

<p align="center">
  <img src="media/translator.png" width="32%" alt="Tradutor" />
  <img src="media/expressions.png" width="32%" alt="Expressões Comuns" />
  <img src="media/vocabulary.png" width="32%" alt="Vocabulário e Checklist" />
</p>

---

### 4. Traduzir de Qualquer Lugar (`Ctrl + Alt + Y`)
Traduza seleções em qualquer parte da IDE:
* **No Editor**: Basta selecionar o bloco de código ou texto e pressionar `Ctrl + Alt + Y` (ou `Cmd + Alt + Y` no Mac).
* **Em Chats, Terminais ou Logs**:
  1. Selecione o texto que deseja traduzir.
  2. Pressione **`Ctrl + C`** para copiar.
  3. Clique no editor de texto para dar foco.
  4. Pressione **`Ctrl + Alt + Y`**!
  O balão de tradução aparecerá instantaneamente com opções de áudio e detalhamento no painel.

### 5. Áudio com Velocidade Ajustável
* Ouça pronúncias usando a **Voz Humana Online do Google (TTS)** ou as **Vozes Locais Offline** instaladas em seu sistema operacional.
* Configure a velocidade de fala (ex: `0.8x`, `1.0x`) nas configurações do painel para treinar seu ouvido no seu próprio ritmo.

---

## ⚙️ Configuração Inicial

Para habilitar a experiência completa com dicas do Coach de IA (Gemini):
1. Acesse o painel do **DevLingo** na barra lateral.
2. Clique no ícone de engrenagem (**⚙️**) para abrir as configurações.
3. Insira sua **Chave de API do Gemini** (você pode gerar uma gratuitamente no [Google AI Studio](https://aistudio.google.com/)).
4. Defina o motor de voz (Online ou Offline) e a velocidade ideal para os seus estudos.

---

## ⌨️ Atalhos de Teclado Úteis

| Atalho | Ação |
| :--- | :--- |
| `Ctrl + Alt + Y` / `Cmd + Alt + Y` | **Traduzir de Qualquer Lugar**: Traduz a seleção atual ou o texto da Área de Transferência. |
| `Ctrl + Alt + T` / `Cmd + Alt + T` | **Substituir Código**: Traduz o texto selecionado e substitui o original diretamente em seu arquivo. |
| `Ctrl + Alt + C` / `Cmd + Alt + C` | **Comentário Bilíngue**: Traduz a seleção e insere um comentário formatado com a versão em Inglês e Português. |

---

## 🧑‍💻 Créditos & Desenvolvimento

Esta extensão foi desenvolvida e idealizada por:
* **Jean Everton** - [LinkedIn Profile](https://www.linkedin.com/in/jeanevertonoficial/)

---

## 📄 Licença

Este projeto está licenciado sob a Licença MIT - consulte o arquivo [LICENSE](LICENSE) para obter mais detalhes.

---

Desenvolvido para ajudar você a conquistar sua próxima vaga internacional ou ler documentações técnicas sem barreiras! 🌐🚀

