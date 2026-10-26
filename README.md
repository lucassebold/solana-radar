# SOLANA RADAR — Smart Wallet Monitor

Duas funções, uma tela:

1. **Ranking mensal** das melhores carteiras (lucro realizado, ROI, taxa de acerto, nº de operações — últimos 30 dias).
2. **Radar de compras sincronizadas**: alerta quando **3 ou mais carteiras distintas** do ranking compram o **mesmo token** dentro de **5 minutos**. O último alerta fica na tela até chegar outro.

Sem banco de dados: tudo fica em memória (ao reiniciar, o radar recomeça vazio e o ranking é buscado de novo).
Sem dependências npm. Funciona em Node 12+.

> Possível oportunidade para análise. Não é recomendação e não garante valorização.

## Como funciona

```
MadeOnSol  --(1 chamada a cada 6 h)-->  ranking top 50  --> lista de carteiras
                                                               |
                                              Helius webhook (enhanced, aviso em ~3 s)
                                                               |
                         compra = saldo do token subiu E a carteira gastou SOL
                                                               |
                           janela móvel de 5 min por token, carteiras únicas
                                                               |
                                              alerta  -->  dashboard (SSE)
```

- **Ranking**: `GET madeonsol.com/api/v1/kol/leaderboard?period=30d&sort=pnl&limit=50` (plano grátis: 200 chamadas/dia; usamos ~4/dia).
- **Radar**: um webhook da Helius com as 50 carteiras. O servidor cria/atualiza **só o seu próprio webhook** (identificado pela URL) e só edita se a lista mudou (cada criação/edição custa 100 créditos).
- **Classificação de compra**: o campo `type` da Helius erra com frequência nas transações da Pump.fun (aparecem como `TRANSFER`/`UNKNOWN`), então ele é ignorado. Usamos as variações de saldo em `accountData`, validadas contra o feed da MadeOnSol.
- **Símbolo/nome do token**: DexScreener (API pública, sem chave). Se falhar, a tela mostra só o mint.

## Configuração

1. Copie `.env.example` para `.env` e preencha:

| Variável | O que é |
|---|---|
| `MADEONSOL_API_KEY` | chave grátis em https://madeonsol.com/developer |
| `HELIUS_API_KEY` | chave grátis em https://dashboard.helius.dev (só necessária com `PUBLIC_URL`) |
| `WEBHOOK_SECRET` | texto aleatório longo (mín. 16). A Helius o envia no cabeçalho `Authorization`; sem ele o servidor responde 401 |
| `PUBLIC_URL` | URL pública do servidor, ex. `https://seu-app.up.railway.app`. **Vazio = modo local** (ranking funciona, radar inativo) |

   Gerar segredo: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`

2. Rodar: `npm start` e abrir http://localhost:3000
3. Testes: `npm test`

Chaves ficam só no backend (`.env` está no `.gitignore`); nada é enviado ao navegador e erros/logs têm as chaves mascaradas.

### Radar ao vivo (precisa de URL pública)

A Helius entrega os avisos por HTTP, então o servidor precisa ser alcançável pela internet: faça deploy (ex.: Railway) ou use um túnel temporário e coloque a URL em `PUBLIC_URL`. Ao subir, o servidor registra o webhook sozinho.
Para parar de gastar créditos: apague o webhook em https://dashboard.helius.dev/webhooks.

## Opcionais (`.env`)

`PORT` (3000) · `RANKING_SIZE` (50) · `RANKING_REFRESH_HOURS` (6) · `WINDOW_MINUTES` (5) · `MIN_WALLETS` (3) · `MIN_BUY_SOL` (0.01) · `DAILY_EVENT_WARN` (30000)

## Limitações confirmadas / conhecidas

- **MadeOnSol grátis**: 200 chamadas/dia; feeds ao vivo têm 5 min de atraso (por isso o radar usa a Helius). A leaderboard não tem atraso.
- **Helius grátis**: 1M créditos/mês, 1 crédito por evento de webhook. O top 50 gera ~9.600 eventos/dia (~290 mil créditos/mês). O painel avisa se o volume do dia passar de `DAILY_EVENT_WARN`.
- **Latência medida** do webhook: mediana 3 s (2–6 s) entre a transação e o aviso.
- **ROI**: a documentação da MadeOnSol não define a unidade de `avg_roi`; é exibido como percentual. Lucro (`pnl`) é em SOL, conforme a doc.
- **Sem histórico**: reiniciar o servidor perde o último alerta e a janela atual (compras dos últimos 5 min não são recuperadas).
- **Termos da MadeOnSol**: o plano grátis é para uso próprio. Antes de abrir o dashboard ao público, leia os termos (há um plano Business com licença de embed e atribuição).
- Se uma carteira do ranking for um bot com milhares de swaps/dia, ela consome créditos; reduza `RANKING_SIZE` se precisar.

## Estrutura

```
src/buyParser.js   evento Helius -> compras (por variação de saldo)
src/detector.js    janela móvel, carteiras únicas, deduplicação, sem spam
src/madeonsol.js   ranking normalizado (ausente = null, nunca 0)
src/helius.js      cria/atualiza o webhook (só o nosso)
src/app.js         orquestra tudo, estado em memória
src/server.js      HTTP: dashboard, /api/state, /events (SSE), /webhook/helius
public/            dashboard (HTML/CSS/JS puro, texto de terceiros sempre via textContent)
test/              32 testes (npm test), com transações reais capturadas como fixture
```
