const os = require('os');
const printer = require('pdf-to-printer');
const config = require('config');
const { PromiseIpc } = require('electron-promise-ipc');
const promiseIpc = new PromiseIpc({maxTimeoutMs: 1500});
const version = require('./../package').version;

const isDevelopment = process.env.NODE_ENV === 'development';

window.app = require('electron').app;
window.ipcRenderer = require('electron').ipcRenderer;
window.promiseIpc = promiseIpc;
window.printer = printer;
window.deviceId = 'EL-' + os.hostname();
window.elVersion = version;

if (isDevelopment) {
    window.devData = {};
    if (config.has('app.username')) {
        window.devData = {...window.devData, userName: config.get('app.username')}
    }
    if (config.has('app.password')) {
        window.devData = {...window.devData, password: config.get('app.password')}
    }
}
