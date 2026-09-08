'use strict';

const config = require('../config');
const selectors = require('../config/selectors');
const logger = require('../logger').child('automation.session');
const { settle, waitMs, captureEvidence } = require('./browser');

/**
 * Gestión de la sesión del sistema web externo real (BusinessNET).
 *
 * Flujo real:
 *   - Al abrir la URL de negocio (horariopersonas.xhtml), el servidor
 *     redirige al portal de seguridad "Seguridad-WEB" (Cerberus, pto 8100).
 *   - Si no hay sesión, aparece el formulario de login (frmLogin).
 *   - Tras loguearse se muestra el home con el módulo APUESTAS.
 *   - Al pulsar APUESTAS se redirige a la app de negocio (pto 8090) con la
 *     sesión activa; entonces se puede navegar a horariopersonas.xhtml.
 *   - Si la sesión expira y vuelve a login, se reloguea automáticamente.
 */

/** Comprueba si la página muestra el formulario de login de Cerberus. */
async function isLoginPage(page) {
  try {
    const sel = selectors.LOGIN_SELECTORS.usernameField;
    if (sel && !String(sel).includes('{{')) {
      const el = await page.$(sel);
      return !!el;
    }
  } catch (_) {
    /* ignore */
  }
  return false;
}

/** Comprueba si la página muestra el home del portal de seguridad (sesión ok). */
async function isHomePage(page) {
  try {
    const sel = selectors.LOGIN_SELECTORS.sessionActiveIndicator;
    if (sel && !String(sel).includes('{{')) {
      const el = await page.$(sel);
      return !!el;
    }
  } catch (_) {
    /* ignore */
  }
  return false;
}

/** Comprueba si la página fue redirigida a noautorizado. */
async function isUnauthorizedPage(page) {
  try {
    const url = page.url();
    if (url.includes('noautorizado')) return true;
  } catch (_) {
    /* ignore */
  }
  return false;
}

/** Completa el formulario de login de Cerberus. */
async function doLogin(page) {
  const { usernameField, passwordField, submitButton } = selectors.LOGIN_SELECTORS;
  const missing = [usernameField, passwordField, submitButton].filter((s) => !s || String(s).includes('{{'));
  if (missing.length > 0) {
    logger.warn('Selectores de login no configurados', { missing });
    return { ok: false, error: 'selectors-not-configured' };
  }

  logger.info('Iniciando sesión en el portal de seguridad');
  await page.waitForSelector(usernameField, { timeout: config.automation.timeoutMs, visible: true });
  await waitMs(1000);
  await page.click(usernameField, { clickCount: 3 });
  await waitMs(500);
  await page.type(usernameField, config.webSystem.user, { delay: 80 });
  await waitMs(1000);

  await page.waitForSelector(passwordField, { timeout: config.automation.timeoutMs, visible: true });
  await page.click(passwordField);
  await waitMs(500);
  await page.type(passwordField, config.webSystem.password, { delay: 80 });
  await waitMs(1000);

  await page.click(submitButton);

  // Esperar a que se cargue el home del portal (sesión activa)
  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await settle(page);
  } catch (_) {
    /* ignore */
  }

  if (await isHomePage(page)) {
    logger.info('Sesión iniciada en el portal de seguridad');
    return { ok: true };
  }
  logger.warn('Login no pudo verificarse');
  return { ok: false, error: 'login-failed' };
}

/** Pulsa el módulo APUESTAS en el home para entrar a la app de negocio. */
async function enterModule(page) {
  const { moduleButton, moduleText } = selectors.MODULE_SELECTORS;
  const isRealSystem = config.webSystem.url.includes('192.168') || config.webSystem.url.includes(':8090');

  if (await isHomePage(page)) {
    logger.info('Entrando al módulo APUESTAS');
    let clicked = false;
    try {
      if (moduleButton && !String(moduleButton).includes('{{')) {
        const el = await page.$(moduleButton);
        if (el) {
          await el.click();
          clicked = true;
        }
      }
      if (!clicked && moduleText) {
        clicked = await page.evaluate((txt) => {
          const links = Array.from(document.querySelectorAll('a'));
          const target = links.find((a) => (a.textContent || '').includes(txt));
          if (target) { target.click(); return true; }
          return false;
        }, moduleText);
      }
    } catch (err) {
      logger.warn('Error al entrar al módulo', { error: err.message });
      clicked = false;
    }

    if (isRealSystem) {
      // En el sistema real, el click en APUESTAS redirige a port 8090 (BusinessNET).
      // Esperar a que la navegación ocurra.
      try {
        await page.waitForFunction(
          () => window.location.href.includes(':8090') || window.location.href.includes('BusinessNET'),
          { timeout: 15000 }
        );
        logger.info('Navegación a BusinessNET completada', { url: page.url() });
      } catch (_) {
        logger.warn('No se detectó navegación a BusinessNET tras 15s', { url: page.url() });
      }
    } else {
      // Mock / file:// — el click actualiza el DOM sin cambiar URL
      await waitMs(2000);
    }
    await settle(page);
  }
}

/**
 * Navega a la sección de horarios de personas, garantizando que haya sesión.
 * Si aparece el login (sesión expirada) reloguea y vuelve a entrar al módulo.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>} true si quedó dentro de la app de negocio
 */
async function ensureLoggedIn(page) {
  const schedulesUrl = config.webSystem.url;
  const isRealSystem = schedulesUrl.includes('192.168') || schedulesUrl.includes(':8090');

  // 1) Navegar a la URL de negocio.
  await page.goto(schedulesUrl, { waitUntil: 'domcontentloaded', timeout: config.automation.timeoutMs });
  await settle(page);

  // 2) Verificar en qué estado estamos
  const url1 = page.url();
  const onLoginPage = await isLoginPage(page);
  const onNoAuth = url1.includes('noautorizado');
  const onTargetPage = onLoginPage ? false : (await isHomePage(page) || !onNoAuth);

  logger.debug('Estado después de navegar', { url: url1, onLoginPage, onNoAuth, onTargetPage });

  // 3) Si estamos en login O en noautorizado, necesitamos reloguear
  if (onLoginPage || onNoAuth || !onTargetPage) {
    if (onNoAuth) {
      logger.warn('Redirigido a noautorizado, navegando al portal de seguridad');
      // Navegar al portal de seguridad forzando login
      await page.goto(schedulesUrl, { waitUntil: 'domcontentloaded', timeout: config.automation.timeoutMs });
      await settle(page);
    }

    if (await isLoginPage(page)) {
      const login = await doLogin(page);
      if (!login.ok) return false;
    }

    await enterModule(page);

    // Verificar que llegamos a port 8090
    const urlAfterModule = page.url();
    logger.debug('URL después de enterModule', { url: urlAfterModule });

    // 4) Navegar a horariopersonas con la sesión de negocio activa.
    //    En el sistema real, intentar hacer click en un enlace del menú
    //    en vez de page.goto, para preservar la sesión PrimeFaces/AJAX.
    if (isRealSystem) {
      await captureEvidence(page, 'inicio-debug');
      logger.info('Screenshot de inicio.xhtml capturado para debug');

      let navigated = false;

      // Estrategia 1: Buscar enlace directo a horariopersonas en la página
      try {
        navigated = await page.evaluate(() => {
          const all = Array.from(document.querySelectorAll('a[href], button'));
          const target = all.find((el) => {
            const href = (el.getAttribute('href') || '').toLowerCase();
            const onclick = (el.getAttribute('onclick') || '').toLowerCase();
            return href.includes('horariopersonas') || onclick.includes('horariopersonas');
          });
          if (target) { target.click(); return true; }
          return false;
        });
        if (navigated) {
          logger.info('Navegación directa a horariopersonas encontrada');
        }
      } catch (_) { /* ignore */ }

      // Estrategia 2: Expandir dropdown "Administrar venta" y buscar submenú
      if (!navigated) {
        try {
          navigated = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a, span, li, div'));
            const adminMenu = links.find((el) => {
              const text = (el.textContent || '').trim();
              return text === 'Administrar venta' || text.startsWith('Administrar venta');
            });
            if (!adminMenu) return false;
            adminMenu.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            adminMenu.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            adminMenu.click();
            return true;
          });
          if (navigated) {
            logger.info('Dropdown "Administrar venta" expandido');
            await waitMs(1500);
            await settle(page);
            // Buscar submenú con enlace a horariopersonas
            navigated = await page.evaluate(() => {
              const all = Array.from(document.querySelectorAll('a[href], li, span, div'));
              const target = all.find((el) => {
                const href = (el.getAttribute('href') || '').toLowerCase();
                const text = (el.textContent || '').toLowerCase().trim();
                return href.includes('horariopersonas')
                  || (text.includes('horario') && text.includes('person'));
              });
              if (target) { target.click(); return true; }
              return false;
            });
            if (navigated) {
              logger.info('Submenú horariopersonas clickeado');
            }
          }
        } catch (err) {
          logger.warn('Error al expandir dropdown', { error: err.message });
          navigated = false;
        }
      }

      if (navigated) {
        await page.waitForFunction(
          (path) => window.location.href.includes(path),
          { timeout: 15000 },
          'horariopersonas'
        ).catch(() => {});
        await settle(page);
      } else {
        logger.info('Fallback: navegación directa a horariopersonas');
        await page.goto(schedulesUrl, { waitUntil: 'domcontentloaded', timeout: config.automation.timeoutMs });
        await settle(page);
      }
    } else {
      await page.goto(schedulesUrl, { waitUntil: 'domcontentloaded', timeout: config.automation.timeoutMs });
      await settle(page);
    }
  }

  // 5) Verificación final: comprobar que no estamos en login ni en noautorizado
  const finalUrl = page.url();
  const finalOnLoginPage = await isLoginPage(page);
  const finalOnNoAuth = finalUrl.includes('noautorizado');
  if (finalOnLoginPage || finalOnNoAuth) {
    logger.warn('La sesión no quedó activa', { url: finalUrl });
    return false;
  }

  // 6) Para el sistema real, verificar que el campo de documento existe (indica sesión funcional)
  if (isRealSystem) {
    const hasDocField = await page.$('#formHorariopersonas\\:txtPrsDocumento');
    if (!hasDocField) {
      logger.warn('Campo de documento no encontrado, sesión posiblemente inválida');
      return false;
    }
  }

  logger.info('Sesión del sistema web establecida');
  return true;
}

module.exports = {
  ensureLoggedIn,
  isLoginPage,
  isHomePage,
  isUnauthorizedPage,
  doLogin,
  enterModule,
};
