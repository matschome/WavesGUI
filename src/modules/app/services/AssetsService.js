(function () {
    'use strict';

    /**
     * @param {app.utils.apiWorker} apiWorker
     * @param {app.utils.decorators} decorators
     * @param {User} user
     * @param {app.utils} utils
     * @param {EventManager} eventManager
     * @return {AssetsService}
     */
    const factory = function (apiWorker, decorators, user, utils, eventManager) {

        const ASSET_NAME_MAP = {
            [WavesApp.defaultAssets.ETH]: 'Ethereum',
            [WavesApp.defaultAssets.EUR]: 'Euro',
            [WavesApp.defaultAssets.USD]: 'Usd',
            [WavesApp.defaultAssets.BTC]: 'Bitcoin'
        };

        class AssetsService {

            /**
             * @param {string} assetId
             * @return {Promise<IAssetInfo>}
             */
            @decorators.cachable()
            getAssetInfo(assetId) {
                if (assetId === 'WAVES') {
                    return user.onLogin()
                        .then(() => ({
                            id: 'WAVES',
                            name: 'Waves',
                            precision: 8,
                            reissuable: false,
                            quantity: 100000000,
                            timestamp: 0
                        }));
                }
                return user.onLogin()
                    .then(() => {
                        return apiWorker.process((Waves, data) => {
                            const { assetId } = data;
                            return Waves.API.Node.v1.transactions.get(assetId);
                        }, { assetId })
                            .then((asset) => ({
                                id: asset.id,
                                name: ASSET_NAME_MAP[asset.id] || asset.name,
                                description: asset.description,
                                precision: asset.decimals,
                                reissuable: asset.reissuable,
                                quantity: asset.quantity,
                                timestamp: asset.timestamp
                            }));
                    });
            }

            /**
             * @param {string} assetId
             * @return {Promise<IAssetWithBalance>}
             */
            getBalance(assetId) {
                return Promise.all([this._getBalance(assetId), eventManager.getBalanceEvents()])
                    .then((data) => {
                        const [asset, events] = data;
                        const clone = tsUtils.cloneDeep(asset);

                        clone.balance = this._getAssetBalance(clone.id, clone.balance, events);
                        return clone;
                    });
            }

            /**
             * @param {Array<string>} [assetIds]
             * @param {Object} [options]
             * @param {Object} [options.limit]
             * @param {Object} [options.offset]
             * @return {Promise}
             */
            getBalanceList(assetIds, options) {
                return user.onLogin().then(() => {
                    if (assetIds) {
                        return utils.whenAll([
                            Promise.all(assetIds.map(this.getAssetInfo)),
                            eventManager.getBalanceEvents(),
                            this._getBalanceList(assetIds, options)
                        ])
                            .then(([assets, events, balances]) => {
                                return assets.map((asset) => {
                                    const balanceData = tsUtils.find(balances, { assetId: asset.id });
                                    const balance = balanceData && parseFloat(balanceData.tokens) || 0;
                                    return { ...asset, balance: this._getAssetBalance(asset.id, balance, events) };
                                });
                            });
                    } else {
                        return utils.whenAll([
                            this._getBalanceList(null, options),
                            eventManager.getBalanceEvents()
                        ])
                            .then(([list, events]) => {
                                return utils.whenAll(list.map((item) => this.getAssetInfo(item.assetId)))
                                    .then((infoList) => {
                                        return infoList.map((asset, i) => {
                                            const balance = parseFloat(list[i].tokens) || 0;
                                            return {
                                                ...asset,
                                                balance: this._getAssetBalance(asset.id, balance, events)
                                            };
                                        });
                                    });
                            });
                    }
                });
            }

            /**
             * @param {string} assetId
             * @param {number} balance
             * @param {Array<ChangeBalanceEvent>} events
             * @return {*}
             * @private
             */
            _getAssetBalance(assetId, balance, events) {
                return events.reduce((balance, balanceEvent) => {
                    return balance - balanceEvent.getBalanceDifference(assetId);
                }, balance);
            }

            /**
             * @param {Array<string>} [assets]
             * @param {Object} [options]
             * @param {Object} [options.limit]
             * @param {Object} [options.offset]
             * @private
             */
            @decorators.cachable(2000)
            _getBalanceList(assets, { limit = null, offset = null } = Object.create(null)) {
                return apiWorker.process((WavesAPI, { assets, address, limit, offset }) => {
                    return WavesAPI.API.Node.v2.addresses.balances(address, { assets, limit, offset })
                        .then((assets) => assets.map(item => item.amount.toJSON()));
                }, { assets, address: user.address, limit, offset });
            }

            /**
             * @param {string} assetId
             * @return {Promise<IAssetWithBalance>}
             * @private
             */
            @decorators.cachable(2000)
            _getBalance(assetId) {
                return this.getAssetInfo(assetId)
                    .then((info) => {
                        const handler = (Waves, { address, assetId }) => {
                            return Waves.API.Node.v1.assets.balance(address, assetId);
                        };
                        const data = { address: user.address, assetId: info.id };

                        return apiWorker.process(handler, data)
                            .then((data) => {
                                // TODO remove " / Math.pow(10, info.precision)" when Phill fix api.
                                return { ...info, balance: data.balance / Math.pow(10, info.precision) };
                            });
                    });
            }

            /**
             * @param {string} assetIdFrom
             * @param {string} assetIdTo
             * @return {Promise<AssetsService.rateApi>}
             */
            @decorators.cachable(1000)
            getRate(assetIdFrom, assetIdTo) {
                // TODO add request to rate when Dmitry make API

                const RATE_MAP = Object.create(null);

                const generate = function (assetId1, assetId2, rate) {
                    RATE_MAP[`${assetId1}-${assetId2}`] = rate;
                    RATE_MAP[`${assetId2}-${assetId1}`] = 1 / rate;
                };

                generate(WavesApp.defaultAssets.WAVES, WavesApp.defaultAssets.USD, 5.11);
                generate(WavesApp.defaultAssets.BTC, WavesApp.defaultAssets.USD, 4050.35);
                generate(WavesApp.defaultAssets.ETH, WavesApp.defaultAssets.USD, 294.33);
                generate(WavesApp.defaultAssets.EUR, WavesApp.defaultAssets.USD, 1.17505);

                const getRate = function (assetId1, assetId2) {
                    let rate = RATE_MAP[`${assetId1}-${assetId2}`];
                    if (!rate) {
                        const from = RATE_MAP[`${assetId1}-${WavesApp.defaultAssets.USD}`];
                        const to = RATE_MAP[`${assetId2}-${WavesApp.defaultAssets.USD}`];
                        rate = from / to;
                    }
                    return rate;
                };

                return utils.whenAll([
                    this.getAssetInfo(assetIdFrom),
                    this.getAssetInfo(assetIdTo),
                    utils.when(getRate(assetIdFrom, assetIdTo))
                ])
                    .then((data) => {
                        const [assetFrom, assetTo, rate] = data;
                        return this._generateRateApi(assetFrom, assetTo, rate);
                    });
            }

            /**
             * @return {Promise<IFeeData>}
             */
            getFeeSend() {
                return utils.when({
                    id: WavesApp.defaultAssets.WAVES,
                    fee: 0.001
                });
            }

            /**
             * @param {IAssetInfo} fromAsset
             * @param {IAssetInfo} toAsset
             * @param {number} rate
             * @returns {AssetsService.rateApi}
             * @private
             */
            _generateRateApi(fromAsset, toAsset, rate) {
                return {
                    /**
                     * @name AssetsService.rateApi#exchange
                     * @param {number} balance
                     * @returns {number}
                     */
                    exchange(balance) {
                        return tsUtils.round(balance * rate, toAsset.precision);
                    },

                    /**
                     * @name AssetsService.rateApi#exchangeReverse
                     * @param {number} balance
                     * @returns {number}
                     */
                    exchangeReverse(balance) {
                        return tsUtils.round(balance / rate, fromAsset.precision);
                    }
                };
            }

        }

        return utils.bind(new AssetsService());
    };

    factory.$inject = ['apiWorker', 'decorators', 'user', 'utils', 'eventManager'];

    angular.module('app')
        .factory('assetsService', factory);
})();

/**
 * @name AssetsService.rateApi
 */

/**
 * @typedef {Object} IFeeData
 * @property {string} id
 * @property {number} fee
 */

/**
 * @typedef {Object} IBalance
 * @property {string} id
 * @property {number} precision
 * @property {number} balance
 */

/**
 * @typedef {Object} IAssetInfo
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {number} precision
 * @property {boolean} reissuable
 * @property {number} quantity
 * @property {number} timestamp
 */

/**
 * @typedef {Object} IAssetWithBalance
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {number} precision
 * @property {number} balance
 * @property {boolean} reissuable
 * @property {number} quantity
 * @property {number} timestamp
 */
