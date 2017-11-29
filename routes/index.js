var express = require('express');

var env = process.env.NODE_ENV || 'development';
var config = require('../config')[env];

var request = require('request');
var IOTA = require('iota.lib.js');
var router = express.Router();

var socketApi = require('../socketApi');
var io = socketApi.io;
var db = require('../filedb/app');

var sockets = [];
var xmrToBtc = 0;
var miotaToBtc = 0;
var iotaUSD = 0;
var payoutPer1MHashes = 0;
var hashIotaRatio = 0;
var totalIotaPerSecond = 0;
var final = 0;
var balanceInProgress = false;
var powInProgress = false;
var blockSpammingProgress = false;
var confirmedSpams = 0;
var countUsersForPayout = 0;
// cache global data
var cacheBalance = 0;
var cacheTransfers = [];
var cacheTotalValue = 0;
// Count loops in queue
var queueTimer = 0;
var roundedQueueTimer = 0;
// init table variable for file database
var tableKeyIndex = db.select("keyIndex");
var tableCache;
var tableQueue;
// External compute unit
var externalComputeSocket = [];


// Check to config for init data
if(tableKeyIndex.data < config.iota.keyIndexStart || config.iota.keyIndexStart === 0){
    tableKeyIndex.data = config.iota.keyIndexStart;
    db.update("keyIndex", tableKeyIndex);
}
// List of https providers
const httpsProviders = [
    "https://iota.onlinedata.cloud:14443"
];
var _currentProvider = getRandomProvider();

function getRandomProvider() {
    return httpsProviders[Math.floor(Math.random() * httpsProviders.length)]
}

// Multi threading
var cp = require('child_process');
// Create IOTA instance with host and port as provider
var iota = new IOTA({
    'host': config.iota.host,
    'port': config.iota.port
});

// Init
// Request on startup

getRates("balance");
getRates("price");

setInterval(function () {
    getRates("price");
    // Wait 5 seconds and send new data to users
    setTimeout(function(){
        emitGlobalValues("", "rates");
    }, 5000);
}, 60000);

function getRates(type){
    switch(String(type)) {
        case "balance":
            // Set balanceInProgress also here for block spamming, until balance progress is done
            balanceInProgress = true;
            var taskIsNodeSynced = function () {
                isNodeSynced("getRates (balance)", function (error, synced) {
                    if (synced) {
                        getBalance();
                    } else {
                        setTimeout(function () {
                            taskIsNodeSynced();
                        }, 5000);
                    }
                });
            };
            taskIsNodeSynced();
            break;
        case "price":
            getTotalIotaPerSecond();
            getPayoutPer1MHashes();
            getXmrToBtc();
            getIotaPrice();
            break;
    }
}

// #BLOCK GET ALL NEEDED DATA FOR CALCULATE PAYOUT
function getHashIotaRatio(){
    // CoinHive convert BTC payout per 1 milion monero hashes
    var xmrInBtcPayout  = xmrToBtc / (1 / payoutPer1MHashes);
    //Convert monero BTC reward to per hash and btc price per 1x iota not million iotas. Ang get result how many iota per coinhive hash
    final = (xmrInBtcPayout/1000000) / (miotaToBtc / 1000000);
    final = final / (100 / config.coinhive.feeRatio);
    hashIotaRatio = final;
    return hashIotaRatio;
}

function getPayoutPer1MHashes(){
    request.get({url: "https://api.coinhive.com/stats/payout", qs: {"secret": config.coinhive.privateKey}}, function(error, response, body) {
        if (!error && response.statusCode == 200) {
            var info = JSON.parse(body);
            payoutPer1MHashes = info.payoutPer1MHashes;
            config.debug && console.log(new Date().toISOString()+" payoutPer1MHashes: " + payoutPer1MHashes);
        }
    });
}

function getTotalIotaPerSecond(){
    request.get({url: "https://api.coinhive.com/stats/site", qs: {"secret": config.coinhive.privateKey}}, function(error, response, body) {
        if (!error && response.statusCode == 200) {
            var info = JSON.parse(body);
            totalIotaPerSecond = (info.hashesPerSecond*getHashIotaRatio()).toFixed(2);
            config.debug && console.log(new Date().toISOString()+" getTotalIotaPerSecond: " + totalIotaPerSecond);
            config.debug && console.log(new Date().toISOString()+" hashIotaRatio: " + hashIotaRatio);
        }
    });
}

function  getXmrToBtc() {
    request.get({url: "https://api.coinmarketcap.com/v1/ticker/monero/"}, function(error, response, body) {
        if (!error && response.statusCode == 200) {
            var info = JSON.parse(body);
            xmrToBtc = info[0].price_btc;
            config.debug && console.log(new Date().toISOString()+" xmrToBtc: " + xmrToBtc);
        }
    });
}

function  getIotaPrice() {
    request.get({url: "https://api.coinmarketcap.com/v1/ticker/iota/"}, function(error, response, body) {
        if (!error && response.statusCode == 200) {
            var info = JSON.parse(body);
            miotaToBtc = info[0].price_btc;
            iotaUSD = info[0].price_usd / 1000000;
            config.debug && console.log(new Date().toISOString()+" miotaToBtc: " + miotaToBtc + "iotaUSD: " + iotaUSD);
        }
    });
}

function getNumberOfOutputsInBundle(){
    if(externalComputeSocket.length > 0){
        return config.externalOutputsInBundle;
    } else {
        return config.outputsInBundle;
    }
}

//#BLOCK QUEUE OF WITHDRAWAL FUNCTION
setInterval(function () {
    var queueAddresses = db.select("queue").addresses;
    if(queueAddresses.length > 0 && cacheBalance > 0 && hashIotaRatio > 0 && !db.select("cache").withdrawalInProgress && !balanceInProgress && !blockSpammingProgress) {

        // Set withdraw is in progress
        blockSpammingProgress = true;
        tableCache = db.select("cache");
        tableCache.withdrawalInProgress = true;
        db.update("cache", tableCache);

        getUserForPayout();
    } else if (queueAddresses.length === 0 && cacheBalance > 0 && hashIotaRatio > 0 && !db.select("cache").withdrawalInProgress && !balanceInProgress && !blockSpammingProgress && config.automaticWithdrawal){
        // If queue is empty, make auto withdrawal to unpaid users
        config.debug && console.log(new Date().toISOString()+" Queue is empty, make auto withdrawal to unpaid users");

        // Set withdraw is in progress
        blockSpammingProgress = true;
        tableCache = db.select("cache");
        tableCache.withdrawalInProgress = true;
        db.update("cache", tableCache);

        getTopUsers(getNumberOfOutputsInBundle());
    } else if (!balanceInProgress && !powInProgress && !blockSpammingProgress && config.spamming){
        // When PoW is sleeping (waiting on confirmation of value transactions), use it for spamming
        //Experiment with spamming mode when no withdrawal
        blockSpammingProgress = true;

        var taskIsNodeSynced = function () {
            isNodeSynced("doSpamming", function repeat(error, result) {
                if(result){
                    doSpamming();
                } else {
                    setTimeout(function(){
                        taskIsNodeSynced();
                    }, 5000);

                }
            });
        };
        taskIsNodeSynced();

    }
}, 1000);

function getUserForPayout(){
    var queueAddresses = db.select("queue").addresses;

    if( db.select("cache").withdrawalInProgress && queueAddresses.length > 0 && countUsersForPayout < parseInt(getNumberOfOutputsInBundle()) ) {
        countUsersForPayout++;
        // Remove socket id and socket for waiting list (using for get position in queue)
        tableQueue = db.select("queue");
        var socketId = tableQueue.ids.shift();
        var requestType = tableQueue.type.shift();
        var requestValue = tableQueue.value.shift();

        // Remove used address from array (get right position in queue)
        var userName = tableQueue.addresses.shift();

        db.update("queue", tableQueue);
        tableQueue = null;

        if(sockets !== undefined ) {
            // Is user socket.id is online, emit he is now in progress
            for (var i = 0; i < sockets.length; ++i) {
                if(socketId === sockets[i].id){
                sockets[i].emit('queuePosition', {position:0});
                break;
                }
            }
        }

        config.debug && console.log(new Date().toISOString() + " Withdrawal in progress for " + userName);

        getUserBalance(userName, requestType, requestValue);
    }
    else if(db.select("cache").withdrawalInProgress && queueAddresses.length === 0 && countUsersForPayout < parseInt(getNumberOfOutputsInBundle()) && config.automaticWithdrawal){
        var outputsTransactionLeft = parseInt(getNumberOfOutputsInBundle()) - parseInt(countUsersForPayout);
        if(outputsTransactionLeft > 0){
            getTopUsers(outputsTransactionLeft);
        }
    }
    else if(db.select("cache").withdrawalInProgress) {
        // Send to waiting sockets in queue their position
        sendQueuePosition();
        //No more addresses in queue or max countUsersForPayout, lets preprepareLocalTransfersp
        config.debug && console.log(new Date().toISOString()+" getUserForPayout transactions in cacheTransfers: " + cacheTransfers.length);
        config.debug && console.log(new Date().toISOString()+" getUserForPayout total amount for prepareLocalTransfers : " + cacheTotalValue);
        // If no total value for make transfer, reset payout and start again
        if(cacheTotalValue > 0){
            prepareLocalTransfers();
        } else {
            resetPayout();
        }
    }
}
function getUserBalance(address, type, customValue){
    request.get({url: "https://api.coinhive.com/user/balance", qs: {"secret": config.coinhive.privateKey, "name": address}}, function (error, response, body) {
        if (!error && response.statusCode === 200) {
            console.log(new Date().toISOString()+" countUsersForPayout: " + countUsersForPayout);
            var data = JSON.parse(body);
            if(data.error){
                console.log(new Date().toISOString()+" Error: Unknown address!");
                // Skip this user and continue
                countUsersForPayout = parseInt(countUsersForPayout) - 1;
                getUserForPayout();
            }  else {
                // Temp payout for skip amount when is not enough balance
                console.log(new Date().toISOString()+" customValue: " + customValue);
                if(customValue === 0){
                    var tempPayout = Math.floor(data.balance*hashIotaRatio);
                } else {
                    var tempPayout = Math.round(customValue);
                }
                //Check if we have balance for transfer
                if((parseInt(cacheTotalValue)+parseInt(tempPayout)) < cacheBalance){
                    var valuePayout = tempPayout;
                    cacheTotalValue += valuePayout;
                    // We can´t payout 0 value reward
                    if(valuePayout > 0){
                        var skipDuplicate = false;
                        //Check duplicity only for withdrawal, not custom transactions
                        if(customValue === 0) {
                            // If getTopUsers called from getUserBalance fill rest of space for manual payments, checking for duplicate
                            db.select("cache").resetUserBalanceList.forEach(function (user) {
                                if (user.name === address) {
                                    console.log(new Date().toISOString() + " Failed: Duplicate payout in resetUserBalanceList, skipping! " + address);
                                    // When duplicate do not add more, skip this user and continue
                                      skipDuplicate = true;
                                }
                            });
                        } else {
                            console.log(new Date().toISOString() + " Custom payout, skipping check duplicates!");
                        }

                        if(!skipDuplicate) {
                            var tmpAddress = getAddressWithoutChecksum(address);
                            isAddressAttachedToTangle(tmpAddress, function (error, result) {
                                console.log(new Date().toISOString() + " Begin: isAddressAttachedToTangle");
                                if(error !== null){
                                    console.log(new Date().toISOString() + " Error: isAddressAttachedToTangle!");
                                    console.log(error);
                                    // Repeat
                                    getUserBalance(address, type, customValue);
                                } else {
                                    if (result === 1 || result === 0) {
                                        console.log(new Date().toISOString() + " isAddressAttachedToTangle result: " + result + " customValue: " + customValue);
                                        if (customValue === 0) {
                                            addTransferToCache(type, address, valuePayout, data.balance);
                                        } else {
                                            addTransferToCache(type, address, customValue, Math.floor(parseFloat(customValue / hashIotaRatio)));
                                        }

                                    } else if (result === -1) {
                                        // If address is not in tangle, reset username on coinhive to get it out from top users
                                        resetUserBalance(address);
                                    }
                                    // Go to next
                                    getUserForPayout();
                                }
                            });
                        } else {
                            //Failed: Duplicate payout in resetUserBalanceList, skipping!
                            countUsersForPayout = parseInt(countUsersForPayout) - 1;
                            // Go to next
                            getUserForPayout();
                        }
                    } else {
                        config.debug && console.log(new Date().toISOString()+" Failed: getUserBalance no hashes for payout! Skipping");
                        countUsersForPayout = parseInt(countUsersForPayout) - 1;
                        // Go to next
                        getUserForPayout();
                    }
                } else {
                    // We have already some transfer data break to prepareLocalTransfers
                    if(cacheTransfers.length > 0){
                        // Send prepared transfers if no more balance for next
                        config.debug && console.log(new Date().toISOString()+" getUserBalance transactions in cacheTransfers: " + cacheTransfers.length);
                        config.debug && console.log(new Date().toISOString()+" getUserBalance total amount for prepareLocalTransfers : " + cacheTotalValue);
                        prepareLocalTransfers();
                    } else {
                        console.log(new Date().toISOString()+" No more balance for next payout!");
                        cacheTransfers.push({
                            "address" : config.remainingBalanceAddress,
                            "value"  : parseInt(cacheBalance),
                            "message" : "MINEIOTADOTCOM9AUTOMATIC9PAYOUT",
                            'tag': "MINEIOTADOTCOM"
                        });
                        prepareLocalTransfers();
                    }
                }
            }
        } else {
            // Repeat
            getUserBalance(address, type, customValue);
        }
    });
}

function addTransferToCache(type, address, amount, hashes){
    var withoutChecksumAddress = getAddressWithoutChecksum(address);
    if(type === "MANUAL" || type === "AUTOMATIC"){
        cacheTransfers.push({
            "address" : withoutChecksumAddress,
            "value"  : parseInt(amount),
            "message" : "MINEIOTADOTCOM9"+type+"9PAYOUT",
            'tag': "MINEIOTADOTCOM"
        });
    } else {
        cacheTransfers.push({
            "address" : withoutChecksumAddress,
            "value"  : parseInt(amount),
            "message" : "MINEIOTADOTCOM9CUSTOM9PAYOUT",
            'tag': type
        });
    }

    //After transaction is confirmed, withdraw coinhive.com balance
    tableCache = db.select("cache");
    tableCache.resetUserBalanceList.push({"name":address,"amount":hashes});
    db.update("cache", tableCache);
}

function getTopUsers(count){
    request.get({url: "https://api.coinhive.com/user/top", qs: {"secret": config.coinhive.privateKey,"count":count,"order":"balance"}}, function(error, response, body) {
        if (!error && response.statusCode == 200) {
            var data = JSON.parse(body);
            for (var i = 0, len = data.users.length; i < len; i++) {
                // Temp payout for skip amount when is not enough balance
                var valuePayout = Math.floor(data.users[i].balance * hashIotaRatio);
                if(valuePayout > 0){
                    var address = data.users[i].name;
                    var skipDuplicate = false;
                    // If getTopUsers called from getUserBalance fill rest of space for manual payments, checking for duplicate
                    if(count < parseInt(getNumberOfOutputsInBundle())){
                        db.select("cache").resetUserBalanceList.forEach(function(user) {
                            if(user.name === address){
                                console.log(new Date().toISOString()+" Duplicate payout in resetUserBalanceList, skipping! " + address);
                                // When duplicate do not add more, skip this user and continue
                                countUsersForPayout = parseInt(countUsersForPayout) - 1;
                                skipDuplicate = true;
                            }
                        });
                    }
                    if(!skipDuplicate){
                        tableQueue = db.select("queue");
                        // Push type of withdrawal
                        tableQueue.type.push("AUTOMATIC");
                        // Custom payout request
                        tableQueue.value.push(0);
                        // Push empty socket id for automatic withdrawal do not need
                        tableQueue.ids.push("");
                        // Push address to array
                        tableQueue.addresses.push(address);
                        // Send to client position in queue
                        db.update("queue", tableQueue);
                        tableQueue = null;
                    }
                } else {
                    console.log(new Date().toISOString()+" User without balance for payout, skipping!");
                }

            }
            getUserForPayout();
        } else {
            resetPayout();
        }
    });
}

function prepareLocalTransfers(){

    config.debug && console.log(new Date().toISOString()+' Transfer worker started');
    config.debug && console.time('trytes-time');
    // Worker for prepare TRYTES transfer
    var transferWorker = cp.fork('workers/transfer.js');

    transferWorker.send({keyIndex:db.select("keyIndex").data});
    transferWorker.send({totalValue:cacheTotalValue});
    transferWorker.send(cacheTransfers);

    transferWorker.on('message', function(result) {
        // Receive results from child process
        if(result.status === "success"){
            // Select actual tableCache
            tableCache = db.select("cache");
            tableCache.trytes = result.result;
            db.update("cache", tableCache);

            // Check node sync, this also call proof of work
            callPoW();

            //We store actual keyIndex for next faster search and transaction
            if(typeof result.keyIndex !== 'undefined'){
                tableKeyIndex.data = result.keyIndex;
                db.update("keyIndex", tableKeyIndex);
                config.debug && console.log(new Date().toISOString()+' Transfer: store actual keyIndex: '+result.keyIndex);
            }
            if(typeof result.inputAddress !== 'undefined'){
                config.debug && console.log(new Date().toISOString()+' Now waiting at confirmation of transaction: '+result.inputAddress);
                checkReattachable(result.inputAddress);
            } else {
                // Something wrong, next in queue can go
                resetPayout();
            }

        } else if (result.status == "error"){
            config.debug && console.log(result);
            // Error transfer worker start again
            resetPayout();
        }
        transferWorker.kill();
    });
    transferWorker.on('close', function () {
        config.debug && console.log(new Date().toISOString()+' Closing transfer worker');
        console.timeEnd('trytes-time');
    });
}

function sendQueuePosition(socket){
    var queueIds = db.select("queue").ids;
    if(socket !== undefined){
        socket.emit('queueTotal', {total: queueIds.length});
    } else if(sockets !== undefined ) {
            // Emit to user in queue his position.
            sockets.forEach(function (socket){
                if(queueIds.indexOf(socket.id) !== -1){
                    config.debug && console.log(new Date().toISOString()+" "+socket.id+" is in queue " + (parseInt(queueIds.indexOf(socket.id))+parseInt(1)));
                    socket.emit('queuePosition', {position: (parseInt(queueIds.indexOf(socket.id))+parseInt(1))});
                }
            });
        // Emit to users total queue
        emitToAll('queueTotal', {total: queueIds.length});
    }
}

//#BLOCK CHECKING CONFIRMED TRANSACTION BEFORE SEND NEW ROUND
var waitConfirm;
// When server restart, check if we have already running waiting on confirmation transaction
if(db.select("cache").isReattachable !== null){
    checkReattachable(db.select("cache").isReattachable);
}

function checkReattachable(inputAddress){
    tableCache = db.select("cache");
    tableCache.isReattachable = inputAddress ;
    db.update("cache", tableCache);
    waitConfirm = setInterval(isReattachable, 30000);
}
// Checking if transaction is confirmed
function isReattachable(){
    if(!powInProgress) {
        var checkAddressIsReattachable = db.select("cache").isReattachable;
        var queueAddresses = db.select("queue").addresses;
        if (checkAddressIsReattachable !== null) {
            queueTimer++;
            iota.api.isReattachable(checkAddressIsReattachable, function (errors, Bool) {
                // If false, transaction was confirmed
                if (!Bool) {
                    //Withdraw user balance only if node is synced (node is only), transactions can be pending and look as confirmed when node is offline
                    if (!balanceInProgress) {
                        var taskIsNodeSynced = function () {
                            isNodeSynced("isReattachable", function repeat(error, synced) {
                                if (synced) {
                                    // We are done, next in queue can go
                                    config.debug && console.log(new Date().toISOString() + " Success: Transaction is confirmed: " + checkAddressIsReattachable);
                                    db.select("cache").resetUserBalanceList.forEach(function (user) {
                                        withdrawUserBalance(user.name, user.amount);
                                    });
                                    // We are done, unset the cache values
                                    resetPayout();
                                    // Get and emit new balance after transaction confirmation
                                    getRates("balance");
                                } else {
                                    setTimeout(function () {
                                        taskIsNodeSynced();
                                    }, 30000);
                                }
                            });
                        };
                        taskIsNodeSynced();
                    }
                } else if (parseInt(queueTimer) > (parseInt(config.skipAfterMinutes)*parseInt(2)) && parseInt(queueAddresses.length) > 0 && config.skipWithdrawal) {
                    // In transaction is not confirmed after 45 minutes, skipping to the next in queue
                    config.debug && console.log(new Date().toISOString() + 'Error: Transaction is not confirmed after 45 minutes, skipping to the next in queue');
                    // Error: Transaction is not confirmed, resetPayout
                    resetPayout();
                } else if (isInteger(parseInt(queueTimer) / (parseInt(config.reattachAfterMinutes)*parseInt(2))) && parseInt(queueTimer) !== 0) {
                    // Add one minute to queue timer
                    // On every 15 minutes in queue, do PoW again
                    config.debug && console.log(new Date().toISOString() + ' Failed: Do PoW again ');
                    // Set rounded queueTimer for round after Proof of Work
                    roundedQueueTimer = queueTimer;
                    // Check if node is synced, this also call proof of work
                    callPoW();
                } else {
                    config.debug && console.log(new Date().toISOString() + ' Miners online: ' + sockets.length);
                    config.debug && console.log(new Date().toISOString() + ' Actual queue run for minutes: ' + queueTimer / 2);
                    config.debug && console.log(new Date().toISOString() + ' Transactions in queue: ' + queueAddresses.length);
                    config.debug && console.log(new Date().toISOString() + ' Waiting on transaction confirmation: ' + checkAddressIsReattachable);
                }
            });
        } else {
            config.debug && console.log(new Date().toISOString() + " Error: inputAddressConfirm: " + checkAddressIsReattachable);
        }
    }
}

function roundQueueTimer(){
    if(queueTimer >= roundedQueueTimer){
        queueTimer = roundedQueueTimer;
    }
}
// Reset total on coinhive.com on request
function resetUserBalance(userName){
    config.debug && console.log("resetUserBalance: "+userName);
    request.post({url: "https://api.coinhive.com/user/reset", form: {"secret": config.coinhive.privateKey, "name":userName}}, function(error, response, body) {
        if (!error && response.statusCode === 200) {
            config.debug && console.log(new Date().toISOString()+" Reset coinhive.com balance result:");
            config.debug && console.log(body);
        }
    });
}
// Withdraw from user balance on coinhive when transaction is confirmed
function withdrawUserBalance(name, amount){
    request.post({url: "https://api.coinhive.com/user/withdraw", form: {"secret": config.coinhive.privateKey, "name":name, "amount":amount}}, function(error, response, body) {
        if (!error && response.statusCode === 200) {
            // If insufficient funds, reset balance to clear user.
            if(body.error === "insufficent_funds"){
                resetUserBalance(name);
            }
            config.debug && console.log(new Date().toISOString()+" Withdraw coinhive.com balance result:");
            config.debug && console.log(body);
        }
    });
}

function resetPayout(){
    // STOP with setInterval until is called again
    clearInterval(waitConfirm);

    // Finished or canceled transaction, can use power resources again for transaction / spam
    powInProgress = false;
    blockSpammingProgress = false;

    // Reset minutes before next queue, waiting on transaction confirmation
    queueTimer = 0;
    // Reset count users in actual payout preparation
    countUsersForPayout = 0;
    // Reset total value for getInputs in transfer worker and for check if mineiota have enough balance
    cacheTotalValue = 0;

    // Select actual tableCache
    tableCache = db.select("cache");
    // Set state for withdrawal progress
    tableCache.withdrawalInProgress = false;
    // input address from balance to checking if transaction is confirmed
    tableCache.isReattachable = null ;
    // Empty list of address for reset balance, we skipping to next in queue
    tableCache.resetUserBalanceList.length = 0;
    // Empty list of trytes data for sendTransaction (attacheToTangle)
    tableCache.trytes.length = 0;

    // Finally update table cache to file db
    db.update("cache", tableCache);

    if(typeof cacheTransfers !== 'undefined'){
        cacheTransfers.length = 0;
    }
}

function callPoW(){
    if(!powInProgress){
        powInProgress = true;
        var taskIsNodeSynced = function () {
            isNodeSynced("callPoW", function repeat(error, synced) {
                if (synced) {
                    if(config.externalCompute && externalComputeSocket.length > 0){
                        config.debug && console.log(new Date().toISOString()+" Info: External PoW worker started");
                        config.debug && console.time('external-pow-time');
                        externalComputeSocket[0].emit('boostAttachToTangle', db.select("cache").trytes);
                    } else {
                        if(env === "production"){
                            //ccurlWorker();
                            doPow();
                        } else {
                            ccurlWorker();
                        }
                    }
                } else {
                    setTimeout(function(){
                        taskIsNodeSynced();
                    }, 30000);
                }
            });
        };
        taskIsNodeSynced();
    }
}

function doPow(){
    config.debug && console.log(new Date().toISOString()+" PoW worker started");
    config.debug && console.time('pow-time');
    // Worker for get IOTA balance in interval
    var powWorker = cp.fork('workers/pow.js');
    // Send child process work to get IOTA balance
    //We pass to worker keyIndex where start looking for funds
    powWorker.send({trytes:db.select("cache").trytes});

    powWorker.on('message', function(trytesResult) {
        // Receive results from child process
        // Get completed transaction info
        // Get only hash from attached transaction
        if(trytesResult.error === 1){
            config.debug && console.log(new Date().toISOString()+ " Error: doPow");
            config.debug && console.log(trytesResult);
            // IF error kill worker and start again after 5 seconds
            powWorker.kill();
            resetPayout();
        } else if(typeof trytesResult[0].bundle !== 'undefined') {
            tableCache = db.select("cache");
            tableCache.bundleHash = trytesResult[0].bundle;
            db.update("cache", tableCache);

            config.debug && console.log("Success: bundle from attached transactions " + trytesResult[0].bundle);
            emitGlobalValues("", "bundle");

            roundQueueTimer();

            powInProgress = false;
            // We have done PoW for transactions with value, now can use power for spamming
            blockSpammingProgress = false;
            powWorker.kill();
        } else {
            config.debug && console.log(trytesResult);
            powWorker.kill();
            resetPayout();
        }
    });
    powWorker.on('close', function () {
        config.debug && console.log(new Date().toISOString()+' Closing PoW worker');
        config.debug && console.timeEnd('pow-time');
    });
}

function doSpamming(){
    config.debug && console.log(new Date().toISOString()+" Spam worker started");
    config.debug && console.time('spam-time');

    var spammerWorker = cp.fork('workers/spammer.js');
    spammerWorker.send("start");

    spammerWorker.on('message', function(result) {
        // Receive results from child process
        // Get completed transaction info
        // Get only hash from attached transaction
        if(result.error === 1){
            config.debug && console.error(new Date().toISOString()+ " Error: spammerWorker");
            config.debug && console.error(result);
            blockSpammingProgress = false;
        } else if(typeof result[0].bundle !== 'undefined') {
            confirmedSpams = parseInt(confirmedSpams) + 2;
            // Emit actual confirmed transactions by spamming network
            emitGlobalValues("" ,"confirmedSpams");
            if(env !== "production"){
            var theTangleOrgUrl = 'https://thetangle.org/bundle/'+result[0].bundle;
            config.debug && console.log("Success: bundle from attached transactions " +theTangleOrgUrl);
            }
            config.debug && console.log(new Date().toISOString()+' Success Spammer worker finished');
            config.debug && console.timeEnd('spam-time');
            blockSpammingProgress = false;
        }
        spammerWorker.kill();
    });
    spammerWorker.on('close', function () {
    });
}

function ccurlWorker(){

    var localAttachToTangle = function(trunkTransaction, branchTransaction, minWeightMagnitude, trytes, callback) {

        var ccurlHashing = require("../ccurl/index");

        ccurlHashing(trunkTransaction, branchTransaction, minWeightMagnitude, trytes, function(error, success) {
            if (error) {
                config.debug && console.error("Error Light Wallet: ccurl.ccurlHashing finished");
                config.debug && console.log(error);
            } else {
                //config.debug && console.log("Success Light Wallet: ccurl.ccurlHashing finished");
            }
            if (callback) {
                return callback(error, success);
            } else {
                return success;
            }
        });
    };

    iota.api.attachToTangle = localAttachToTangle;

    var depth = 3;
    var minWeightMagnitude = 14;
    config.debug && console.log(new Date().toISOString()+" PoW worker started");
    config.debug && console.time('pow-time');
    iota.api.sendTrytes(db.select("cache").trytes, depth, minWeightMagnitude, function (error, success) {
        if (error) {
            console.error("Sorry, something wrong happened... lets try it again after 5 sec");
            config.debug && console.error(error);
            config.debug && console.timeEnd('pow-time');

            roundQueueTimer();
            // Check if node is synced, this also call proof of work
            setTimeout(function(){
                callPoW();
            }, 5000);

        } else {
            tableCache = db.select("cache");
            tableCache.bundleHash = success[0].bundle;
            db.update("cache", tableCache);

            var theTangleOrgUrl = 'https://thetangle.org/bundle/'+success[0].bundle;
            console.log("Success: bundle from attached transactions " +theTangleOrgUrl);

            emitGlobalValues("", "bundle");
            // Round down queue timer to get get exactly 15 min for confirmation
            roundQueueTimer();

            config.debug && console.log(new Date().toISOString()+' PoW worker finished');
            console.timeEnd('pow-time');

            powInProgress = false;
            // We have done PoW for transactions with value, now can use power for spamming
            blockSpammingProgress = false;
        }
    });
}

function isNodeSynced(type, callback){
    config.debug && console.log(new Date().toISOString()+" Checking if node is synced: " + type);
    iota.api.getNodeInfo(function(error, success){
        if(error) {
            config.debug && console.log(new Date().toISOString()+" Error occurred while checking if node is synced");
            config.debug && console.log(error);
            callback(null, false);
        } else {
            const isNodeUnsynced =
                success.latestMilestone == config.iota.seed ||
                success.latestSolidSubtangleMilestone == config.iota.seed ||
                success.latestSolidSubtangleMilestoneIndex < success.latestMilestoneIndex;

            const isNodeSynced = !isNodeUnsynced;

            if(isNodeSynced) {
                config.debug && console.log(new Date().toISOString()+" Node is synced");
                callback(null, true);
            } else {
                config.debug && console.log(new Date().toISOString()+" Failed: Node is not synced.");
                callback(null, false);
            }
        }

    });
}

//# BLOCK HELPERS FUNCTIONS
function isAddressAttachedToTangle(address, callback) {
    iota.api.findTransactions({"addresses":new Array(address)}, function (errors, success) {
        if(!errors){
            if (success.length === 0) {
                //config.debug && console.log(new Date().toISOString()+' Error: '+address+' is not attached and confirmed to tangle! ');
                callback(null, -1);
            } else {
                iota.api.getLatestInclusion(success, function (errors, success) {
                    for (var i = 0, len = success.length; i < len; i++) {
                        if(success[i] === true){
                            callback(null, 1);
                            return;
                        }
                    }
                    config.debug && console.log(new Date().toISOString()+' Warning: '+address+' is attached, but not confirmed to tangle! ');
                    callback(null, 0);
                })
            }
        } else {
            console.log(errors);
        }
    });
}
function getAddressWithoutChecksum(address){
    // Get only 81-trytes address format
    // Check if address is 81-trytes address
    if(!isHash(address)){
        // If is address with checksum do check
        if(isValidChecksum(address)){
            // If is address correct, remove checksum
            address = noChecksum(address);
        } else {
            console.log(new Date().toISOString()+" invalid checksum: ");
            console.log(address);
        }
    }
    return address;
}
function isAddress(address){
    return iota.valid.isAddress(address);
}
function isHash(hash){
    return iota.valid.isHash(hash);
}
function isValidChecksum(addressWithChecksum){
    return iota.utils.isValidChecksum(addressWithChecksum);
}
function noChecksum(addressWithChecksum){
    return iota.utils.noChecksum(addressWithChecksum);
}
// Check if it is rounded interger and not float
function isInteger(n) {
    return n === +n && n === (n|0);
}

function getBalance(){
    balanceInProgress = true;
    config.debug && console.log(new Date().toISOString()+" Balance worker started");
    config.debug && console.time('balance-time');
    // Worker for get IOTA balance in interval
    var balanceWorker = cp.fork('workers/balance.js');
    // Send child process work to get IOTA balance
    //We pass to worker keyIndex where start looking for funds
    balanceWorker.send({keyIndex:db.select("keyIndex").data});

    balanceWorker.on('message', function(balanceResult) {
        // Receive results from child process
        balanceInProgress = false;
        config.debug && console.log(balanceResult);
        if(typeof balanceResult.inputs !== 'undefined' && balanceResult.inputs.length > 0){
            //We store actual keyIndex for next faster search and transaction
            tableKeyIndex.data = balanceResult.inputs[0].keyIndex;
            db.update("keyIndex", tableKeyIndex);
            config.debug && console.log(new Date().toISOString()+' Balance: store actual keyIndex: '+balanceResult.inputs[0].keyIndex);
        }
        config.debug && console.log(new Date().toISOString()+" Faucet balance: " + balanceResult.totalBalance);
        if(Number.isInteger(balanceResult.totalBalance)){
            cacheBalance = balanceResult.totalBalance;
        } else {
            cacheBalance = " Running syncing of database, please wait! "
        }
        balanceWorker.kill();
    });
    balanceWorker.on('close', function () {
        config.debug && console.log(new Date().toISOString()+' Closing balance worker');
        console.timeEnd('balance-time');
        emitGlobalValues("", "balance");
    });
}

function manualPayment(){
    cacheTransfers.push({
        "address" : "GLQRBYHTEVJDRGPUFNEBT9PIGFPKSRWPVDUTPEYMBDTNTZWLQZJ9H9QA9G9NFVHYOIYEZYQBTCTSHCOXADANQACY9C",
        "value"  : parseInt(0),
        "message" : "MINEIOTADOTCOM9AUTOMATIC9PAYOUT9CCURL",
        'tag': "MINEIOTADOTCOM"
    });
    prepareLocalTransfers();
}


// SOCKET.IO Communication
io.on('connection', function (socket) {
    // Set new connection socket to array
    sockets.push(socket);

    // Emit actual values to all users
    emitGlobalValues(socket, "all");
    emitGlobalValues("", "online");
    //Emit actual length of queue
    sendQueuePosition(socket);

    // On disconnect remove socket from array sockets
    socket.on('disconnect', function(){
        var i = sockets.indexOf(socket);
        if(i != -1) {
            sockets.splice(i, 1);
        }
        if(socket === externalComputeSocket[0]){
            config.debug && console.log(new Date().toISOString()+' Warning: external compute unit is disconnected');
            externalComputeSocket = [];
        }
        emitGlobalValues("", "online");
    });

    //When user set address check if is valid format
    socket.on('login', function (data, fn) {
        if(isAddress(data.address)){
            var address = getAddressWithoutChecksum(data.address);
            isAddressAttachedToTangle(address, function(error, result) {
                if(result === 1){
                    fn({done:1,publicKey:config.coinhive.publicKey,username:data.address});
                } else if(result === 0) {
                    console.log('Warning: '+address+' is attached, but not confirmed to tangle');
                    fn({done:0,publicKey:config.coinhive.publicKey,username:data.address});
                } else if(result === -1) {
                    console.log('Error login: '+address+' is not attached and confirmed to tangle');
                    fn({done:-1});
                }
            });
        } else {
            fn(false);
        }
    });

    socket.on('externalComputeLogin', function (data, fn) {
            if(data.password === config.externalComputePassword){
                config.debug && console.log(new Date().toISOString()+' Success: external compute unit is connected');
                externalComputeSocket.push(socket);
                fn({done:1});
            } else {
                config.debug && console.log(new Date().toISOString()+' Error: external compute unit set wrong password');
                fn({done:0});
            }
    });

    //When user request actual balance
    socket.on('getUserActualBalance', function(data, fn) {
        request.get({url: "https://api.coinhive.com/user/balance", qs: {"secret": config.coinhive.privateKey, "name": data.address}}, function (error, response, body) {
            if (!error && response.statusCode === 200) {
                var data = JSON.parse(body);
                if(data.error){
                    fn({done:0});
                }  else {
                    // We can´t payout 0 value reward
                    var valuePayout = Math.floor(data.balance*hashIotaRatio);
                    fn({done:1, balance:valuePayout});
                }
            } else {
                fn({done:0});
            }
        });

    });

    //When user with request withdraw
    socket.on('withdraw', function(data, fn) {
        var fullAddress = data.address;
        var customTag = data.tag;
        var customValue = data.value;
        config.debug && console.log("Requesting withdraw for address: " + fullAddress);
        if(isAddress(fullAddress)){
            var queueAddresses = db.select("queue").addresses;
            // Check if withdrawal request inst already in queue
            if(queueAddresses.indexOf(fullAddress) >= 0 && customTag === null && customValue === null){
                fn({done:-1,position:(parseInt(queueAddresses.indexOf(fullAddress))+parseInt(1))});
            } else  {
                tableQueue = db.select("queue");
                // Push type of withdrawal
                if(typeof customTag === 'undefined' && typeof customTag === 'undefined'){
                    //TODO remove after all will be updated
                    tableQueue.type.push("MANUAL");
                    tableQueue.value.push(0);
                } else {
                    if(customTag === null || customValue === null){
                        tableQueue.type.push("MANUAL");
                        tableQueue.value.push(0);
                    } else if (customTag !== null && customValue !== null) {
                        tableQueue.type.push(customTag);
                        tableQueue.value.push(customValue);
                    }
                }

                // Push socket id to array for get position in queue
                tableQueue.ids.push(socket.id);
                // Push address to array
                tableQueue.addresses.push(fullAddress);
                // Send to client position in queue
                config.debug && console.log(fullAddress + " is in queue " + (parseInt(tableQueue.ids.indexOf(socket.id)) + parseInt(1)));
                socket.emit('queuePosition', {position: (parseInt(tableQueue.ids.indexOf(socket.id)) + parseInt(1))});

                db.update("queue", tableQueue);
                tableQueue = null;

                // Respond success
                fn({done: 1});

                // Now update queue position for all users
                sendQueuePosition();
            }
        } else {
            // Respond error
            fn({done:0});
        }
    });
    //When external compute complete PoW, send hash transaction to all clients
    socket.on('newWithdrawalConfirmation', function (data) {
        tableCache = db.select("cache");
        tableCache.bundleHash = data.bundle;
        db.update("cache", tableCache);

        config.debug && console.log(new Date().toISOString()+' Success: External computing unit finished PoW');
        config.debug && console.timeEnd('external-pow-time');

        powInProgress = false;
        emitGlobalValues("" ,"bundle");
    });
    socket.on('boostRequest', function () {
        //socket.emit('announcement', "Boost is disabled. Thank you for your help");
        if(db.select("cache").trytes.length !== 0){
        socket.emit("boostAttachToTangle", db.select("cache").trytes, function(confirmation){
            if(confirmation.success == true){
                config.debug && console.log(new Date().toISOString()+ " "+socket.id+' emit attachToTangle to client success');
            } else {
                config.debug && console.log(new Date().toISOString()+ " "+socket.id+' emit attachToTangle to client failed, maybe is disconnected or already do PoW');
            }
        });
        } else {
            socket.emit('announcement', "No unconfirmed transaction for boost. Thank you for your help");
        }
    });
});

// Emit global cache data to connected user
function emitGlobalValues(socket, type){
    var emitData = {};
    switch(String(type)) {
        case "all":
            emitData = {balance: cacheBalance, bundle: db.select("cache").bundleHash, count: sockets.length, iotaUSD:iotaUSD, totalIotaPerSecond: totalIotaPerSecond, hashIotaRatio: getHashIotaRatio(), confirmedSpams: confirmedSpams};
            break;
        case "online":
            emitData = {count: sockets.length};
            break;
        case "balance":
            emitData = {balance: cacheBalance};
            break;
        case "bundle":
            emitData = {bundle: db.select("cache").bundleHash};
            break;
        case "confirmedSpams":
            emitData = {confirmedSpams: confirmedSpams};
            break;
        case "rates":
            emitData = {iotaUSD:iotaUSD, totalIotaPerSecond: totalIotaPerSecond, hashIotaRatio: getHashIotaRatio()};
            break;
    }
    // balance, last bundle, minerr online, hashIotaRatio
    if(socket !== ""){
        socket.emit('globalValues', emitData);
    } else {
        emitToAll('globalValues', emitData)
    }
}
function emitToAll(event, data){
    if(sockets !== undefined) {
        sockets.forEach(function (socketSingle){
            socketSingle.emit(event, data);
        });
    }
}

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index', { title: 'IOTA Faucet - Get IOTA through mining Monero', iotaProvider:"'"+_currentProvider+"'"});
});

module.exports = router;
