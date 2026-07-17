# Entrega do cliente de autenticação

O cliente JavaScript do Supabase é servido pelo próprio backend em:

```text
/assets/supabase-2.js
```

## Motivo

A aplicação não pode depender de um CDN no navegador. Proteções de rastreamento podem bloquear domínios externos, e serviços do Render criados manualmente podem ignorar o `buildCommand` presente no `render.yaml`.

## Estratégia

1. Usar `static/vendor/supabase.js` quando o build local tiver gerado o arquivo.
2. Usar o cache persistido em `/tmp` quando disponível.
3. Baixar a versão fixa `2.110.7` pelo backend somente quando os arquivos locais não existirem.
4. Validar o SHA-256 antes de servir o bundle.
5. Entregar o script como recurso same-origin com cache imutável.
6. Retornar um script de erro executável e sem cache se nenhuma origem estiver disponível.

A autenticação, a colaboração e o Realtime continuam usando a API oficial do `@supabase/supabase-js`; apenas a forma de entrega do bundle ao navegador foi alterada.
