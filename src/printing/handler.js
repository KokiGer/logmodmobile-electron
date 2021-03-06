const config = require('config');
const eventEmitter = require('./../websocket/eventEmitter');
const restClientInstance = require('./../restClient');
const tmp = require('tmp');
const fs = require('fs');
const printer = require('pdf-to-printer');
const {getDocumentPrinter, getProductLabelPrinter, getShipmentLabelPrinter} = require('./printer');
const {logDebug} = require('./../logging');

const useGsPrint = config.has('app.gsPrintExecutable');
const gsPrintExecutable = useGsPrint ? config.get('app.gsPrintExecutable') : '';

class PrintingHandler {
    /**
     * list of all created temporary files in this session
     * need this to cleanup when application is shut down
     *
     * @type {[{string}]}
     */
    createdFilesCache = [];

    /**
     * initializes the handler
     */
    initialize = () => {
        if (!config.has('printing')) {
            throw new Error('no printing defined in config. invalid config?')
        }

        this._registerEventListener();
    };

    /**
     * cleaning up all temporary created files
     */
    cleanup = () => {
        this.createdFilesCache.forEach((file) => {
            try {
                fs.unlinkSync(file)
            } catch {
            }
        });
    };

    /**
     * all events we are listening for
     *
     * @private
     */
    _registerEventListener = () => {
        eventEmitter.on('requestDocuments', this._requestDocuments);
        eventEmitter.on('invoiceCreationSuccess', this._printInvoiceCreationResultDocuments);
        eventEmitter.on('shipmentLabelPrint', this._handleShipmentLabelPrinting)
    };

    /**
     * printing invoices got from invoice handler
     *
     * @param {{advertisingMediumCode:string, deliveryCountryCode: string, deliveryCountryIsEu: boolean, base64encodedInvoice: string, base64encodedDeliverySlip:string, base64encodedReturnSlip: string}} data
     * @private
     */
    _printInvoiceCreationResultDocuments = (data) => {
        const resultData = {
            advertisingMedium: data.advertisingMediumCode,
            deliveryCountry: data.deliveryCountryCode,
            isEU: data.deliveryCountryIsEu
        };

        if (data.hasOwnProperty('base64encodedInvoice') && data.base64encodedInvoice) {
            this._handleDocumentPrinting('invoice', resultData, data.base64encodedInvoice);
        }

        if (data.hasOwnProperty('base64encodedDeliverySlip') && data.base64encodedDeliverySlip) {
            this._handleDocumentPrinting('delivery', resultData, data.base64encodedDeliverySlip);
        }

        if (data.hasOwnProperty('base64encodedReturnSlip') && data.base64encodedReturnSlip) {
            this._handleDocumentPrinting('return', resultData, data.base64encodedReturnSlip);
        }
    };

    /**
     * requesting documents from blisstribute and print them
     *
     * @param {{productEan:string, templateId:int, invoiceNumber:string}} data
     *
     * @private
     */
    _requestDocuments = (data) => {
        if (!data || !data.hasOwnProperty('documentType')) {
            return;
        }

        switch (data.documentType.toUpperCase()) {
            case 'PRODUCTLABEL': {
                if (!data.hasOwnProperty('productEan')) {
                    this._handleError(new Error('invalid data, no ean number given'));
                    return;
                }

                restClientInstance.requestProductLabel(data.productEan, data.templateId).then((response) => {
                    this._handleProductLabelPrinting(response.response.content, data.quantity);
                }).catch(this._handleError);
                break;
            }
            case 'INVOICE': {
                if (!data.hasOwnProperty('invoiceNumber')) {
                    this._handleError(new Error('invalid data, no invoice number given'));
                    return;
                }

                restClientInstance.requestInvoiceDocument(data.invoiceNumber).then((response) => {
                    this._handleDocumentPrinting('invoice', response.response, response.response.content)
                }).catch(this._handleError);
                break;
            }
            case 'DELIVERY': {
                if (!data.hasOwnProperty('invoiceNumber')) {
                    this._handleError(new Error('invalid data, no invoice number given'));
                    return;
                }

                restClientInstance.requestDeliverySlipDocument(data.invoiceNumber).then((response) => {
                    this._handleDocumentPrinting('delivery', response.response, response.response.content)
                }).catch(this._handleError);
                break;
            }
            case 'RETURN': {
                if (!data.hasOwnProperty('invoiceNumber')) {
                    this._handleError(new Error('invalid data, no invoice number given'));
                    return;
                }

                restClientInstance.requestReturnSlipDocument(data.invoiceNumber).then((response) => {
                    this._handleDocumentPrinting('return', response.response, response.response.content)
                }).catch(this._handleError);
                break;
            }
            case 'ALLDOCS': {
                if (!data.hasOwnProperty('invoiceNumber')) {
                    this._handleError(new Error('invalid data, no invoice number given'));
                    return;
                }

                restClientInstance.requestAllDocuments(data.invoiceNumber).then((response) => {
                    this._handleDocumentPrinting('invoice', response.response, response.response.invoicePdf);
                    this._handleDocumentPrinting('delivery', response.response, response.response.deliverySlipPdf);
                    this._handleDocumentPrinting('return', response.response, response.response.returnSlipPdf);
                }).catch(this._handleError);
                break;
            }
        }
    };

    /**
     * printing error handler
     *
     * @param {Error} err
     *
     * @private
     */
    _handleError = (err) => {
        console.log('error', err);
    };

    /**
     * helper method to save base64encoded file content to temporary files
     *
     * @param {string} contentToPrint
     *
     * @returns {string}
     *
     * @private
     */
    _saveResultToPdf = (contentToPrint) => {
        const tmpFile = tmp.fileSync({prefix: 'ellmm_', postfix: '.pdf'});
        const documentEncoded = Buffer.from(contentToPrint, 'base64');
        fs.writeFileSync(tmpFile.name, documentEncoded);

        this.createdFilesCache.push(tmpFile.name);

        return tmpFile.name;
    };

    /**
     * printing a document
     *
     * @param {string} type
     * @param {{advertisingMedium:string, deliveryCountry:string, isEU: boolean}} data
     * @param {string} contentToPrint
     * @private
     */
    _handleDocumentPrinting = (type, data, contentToPrint) => {
        if (!contentToPrint || contentToPrint.length < 100) {
            return;
        }

        const tmpFileName = this._saveResultToPdf(contentToPrint);

        const printerConfig = getDocumentPrinter(type, data.advertisingMedium, data.deliveryCountry, data.isEU);
        const printingOptions = this._getOptionsForPrinting(printerConfig);

        logDebug('printingHandler', '_handleDocumentPrinting', 'start printing with options ' + JSON.stringify(printingOptions));
        printer.print(tmpFileName, printingOptions).then(console.log).catch(console.log);
    };

    /**
     * printing product label
     *
     * @param {string} contentToPrint
     * @param {int} numberOfCopies
     *
     * @private
     */
    _handleProductLabelPrinting = (contentToPrint, numberOfCopies) => {
        if (!contentToPrint || contentToPrint.length < 100) {
            return;
        }

        const tmpFileName = this._saveResultToPdf(contentToPrint);
        
        const printerConfig = getProductLabelPrinter(numberOfCopies);
        const printingOptions = this._getOptionsForPrinting(printerConfig);

        logDebug('printingHandler', '_handleProductLabelPrinting', 'start printing with options ' + JSON.stringify(printingOptions));
        printer.print(tmpFileName, printingOptions).then(console.log).catch(console.log);
    };

    /**
     * printing labels got from shipping handler
     *
     * @param {{shipmentTypeCode:string, shipmentLabelCollection: [{packageId:string, trackingId:string, shipmentLabel:string, returnLabel:string}]}} data
     *
     * @private
     */
    _handleShipmentLabelPrinting = (data) => {
        const printerConfig = getShipmentLabelPrinter(data.shipmentTypeCode);
        const printingOptions = this._getOptionsForPrinting(printerConfig);

        data.shipmentLabelCollection.forEach((label) => {
            if (label.shipmentLabel && label.shipmentLabel.trim() !== '') {
                let shipmentTmpFile = this._saveResultToPdf(label.shipmentLabel);
    
                logDebug('printingHandler', '_handleShipmentLabelPrinting', 'start printing with options ' + JSON.stringify(printingOptions));
                printer.print(shipmentTmpFile, printingOptions).then(console.log).catch(console.log);
            }

            if (label.returnLabel && label.returnLabel.trim() !== '') {
                let returnTmpFile = this._saveResultToPdf(label.returnLabel);
                logDebug('printingHandler', '_handleShipmentLabelPrinting', 'start printing with options ' + JSON.stringify(printingOptions));
                printer.print(returnTmpFile, printingOptions).then(console.log).catch(console.log);
            }
        });
    };
    
    /**
     * map printer configuration to pdf-to-printer options
     *
     * @param {{}} printerConfig
     * @param {int} numberOfCopies
     * @returns {{}}
     * @private
     */
    _getOptionsForPrinting = (printerConfig, numberOfCopies = 1) => {
        let options = {};
        if (printerConfig.printer) {
            options.printer = printerConfig.printer;
        }
        
        numberOfCopies = printerConfig.numOfCopies || numberOfCopies;
    
        if (useGsPrint) {
            options.gsprint = {
                executable: gsPrintExecutable
            }
        
            options.win32 = ['-color'];
        
            if (numberOfCopies) {
                options.win32.push('-copies "' + numberOfCopies + '"');
            }
        
            if (printerConfig.rotate) {
                options.win32.push('-landscape');
            }
        } else {
            if (numberOfCopies) {
                options.unix = ['-n ' + numberOfCopies];
                options.win32 = ['-print-settings "' + numberOfCopies + 'x"'];
            }
        }
        
        return options;
    }
}

module.exports = PrintingHandler;