# 🧪 Agenda Laura — Ambiente de pruebas

**Este es el ambiente de pruebas de [Agenda Laura](https://github.com/dbustam7-alt/agendaslaura).** Mismo código, pero con su propia base de datos separada (proyecto Supabase distinto) — nada de lo que hagas aquí afecta la app real ni sus datos.

- **App real (producción)**: https://dbustam7-alt.github.io/agendaslaura/
- **App de pruebas (este repo)**: se activa igual que la real, con GitHub Pages → Settings → Pages → Deploy from a branch → `main` → `/ (root)`.

## Para qué sirve

Probar cambios nuevos con clics reales (no solo con las pruebas automatizadas) antes de llevarlos a la app que ya usa el equipo. Los datos aquí son de ejemplo (3 entidades semilla: CES, AUNA, NOEL con tarifas de prueba) — puedes romper, borrar o inventar lo que quieras sin ningún riesgo.

## Cómo se mantiene sincronizado con producción

No es automático. Cuando se prueba un cambio aquí y se decide llevarlo a producción, se aplica el mismo cambio (código + migración de base de datos si aplica) al repositorio `agendaslaura` y a su proyecto Supabase real.

## Cuenta de acceso

Este proyecto Supabase de pruebas necesita su propia cuenta de acceso (independiente de la real): [Dashboard de Supabase](https://supabase.com/dashboard) → proyecto **"Agenda Laura - Staging"** → Authentication → Users → "Add user".

Para el resto (autenticación, estructura de tablas, reglas de negocio), ver el `README.md` del repositorio de producción.
