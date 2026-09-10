# TikTok Favorites Cleaner

Extensión local para quitar videos guardados de TikTok por lotes, usando la sesión abierta en el navegador. No usa Playwright, servidor externo ni cookies fuera de TikTok.

> Proyecto comunitario, experimental y sin afiliación con TikTok. TikTok puede cambiar su web, limitar solicitudes o mostrar CAPTCHA en cualquier momento.

## Qué incluye

- `chrome-extension/`: versión para Chrome y Chromium.
- `firefox-extension/`: versión para Firefox.
- `dist/`: ZIPs listos para instalar o compartir de la versión 0.9.8.

La extensión lee la lista autenticada de guardados, abre cada publicación y pulsa el control real de guardar/quitar guardar. Trabaja por lotes y conserva logs locales para diagnosticar respuestas 403/429, CAPTCHA, cambios de ruta y estados ambiguos.

Por seguridad, si la lista interna de TikTok dice “guardado” pero el botón visible dice “Agregar a favoritos”, el elemento se omite sin hacer clic. Una respuesta HTTP exitosa no se interpreta por sí sola como una eliminación.

## Instalación

### Chrome / Chromium

1. Abre `chrome://extensions`.
2. Activa **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y selecciona `chrome-extension/`.
4. Abre TikTok con la sesión iniciada y pulsa el icono de la extensión.

### Firefox

1. Abre `about:debugging`.
2. Entra en **Este Firefox**.
3. Pulsa **Cargar complemento temporal**.
4. Selecciona el ZIP de `dist/` o el `manifest.json` de `firefox-extension/`.

## Prueba recomendada

Empieza con un lote de 1 a 3 videos y un rango de fechas pequeño. Mantén desactivada la opción de permitir estado desconocido. Si un video se omite, revisa los logs antes de reintentarlo.

La opción **Verificar la lista completa al terminar** puede tardar bastante porque recorre las páginas que devuelve TikTok. La pausa entre acciones también puede aumentar automáticamente si TikTok responde con señales de limitación.

## Privacidad y límites

- Todo se ejecuta en el navegador del usuario.
- No se envían cookies, tokens ni logs a un servidor propio.
- Los logs pueden contener rutas, IDs públicos de publicaciones y estados HTTP; no los publiques si no quieres compartir esa información.
- No intenta resolver CAPTCHA ni evadir bloqueos.
- Los videos eliminados, privados o retirados por TikTok pueden dejar contadores o referencias que no aparecen en la cuadrícula.

## Licencia

MIT. Consulta `LICENSE`.
