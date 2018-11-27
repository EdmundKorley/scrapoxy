'use strict';

const _ = require('lodash'),
    Promise = require('bluebird'),
    GoogleCompute = require('@google-cloud/compute'),
    InstanceModel = require('../../proxies/manager/instance.model'),
    ScalingError = require('../../common/error/scaling'),
    winston = require('winston');


module.exports = class ProviderGCloudCompute {
    constructor(config, instancePort) {
        if (!config || !instancePort) {
            throw new Error('[ProviderGCloudCompute] should be instanced with config and instancePort');
        }

        this._config = config;
        this._config.name = this._config.name || 'proxy';

        this._instancePort = instancePort;

        this.name = 'gcloudcompute';

        const opts = _.pick(this._config, ['projectId', 'credentials'])
        this._gc = new GoogleCompute(opts)
    }


    static get ST_PROVISIONING() {
        return 'PROVISIONING';
    }

    static get ST_STAGING() {
        return 'STAGING';
    }

    static get ST_RUNNING() {
      return 'RUNNING';
    }

    static get ST_STOPPING() {
        return 'STOPPING';
    }

    static get ST_TERMINATED() {
        return 'TERMINATED';
    }

    async region(vmName) {
        if (this._config.instance.region === 'random') {
            const VMs = (await this._gc.getVMs())[0] // [response, defaultResponse] we are only intereseted in the response
            const region = VMs.filter(vm => vm.name === vmName)[0].zone.id

            return region
        } else {
            return this._config.instance.region;
        }
    }

    get models() {
        const self = this;

        return getVMs()
            .then(summarizeInfo)
            .then(excludeTerminated)
            .then(excludeOutscope)
            .then(convertToModel);


        ////////////
        function getVMs() {
          return self._gc.getVMs().then(VMs => VMs[0])
        }

        function summarizeInfo(VMs) {
            return _.map(VMs, (VM) => ({
                id: VM.id,
                status: VM.metadata.status,
                ip: VM.metadata.networkInterfaces[0].accessConfigs[0].natIP,
                name: VM.name,
                tag: getTag(VM)
            }))

            ////////////
            function getTag(VM) {
              const tags = VM.metadata.tags.items

              if (tags) {
                return tags.slice(-1)[0]
              }
            }
        }


        function excludeTerminated(VMs) {
            return _.filter(VMs,
                (VM) => 
                VM.status !== ProviderGCloudCompute.ST_STOPPING &&
                VM.status !== ProviderGCloudCompute.ST_TERMINATED
            );
        }


        function excludeOutscope(VMs) {
            return _.filter(VMs,
                (VM) => VM.name && VM.name.indexOf(self._config.name) === 0
            );
        }

        function convertToModel(VMs) {
            const models = _.map(VMs, async (VM) => {
                const region = await self.region(VM.name)

                return new InstanceModel(
                    VM.id,
                    self.name,
                    convertStatus(VM.status),
                    false,
                    buildAddress(VM.ip),
                    region,
                    VM
                )
            });

            return Promise.all(models)

            ////////////

            function buildAddress(ip) {
                if (!ip) {
                    return;
                }

                return {
                    hostname: ip,
                    port: self._instancePort,
                };
            }

            function convertStatus(status) {
                switch (status) {
                    case ProviderGCloudCompute.ST_PROVISIONING:
                    case ProviderGCloudCompute.ST_STAGING:
                    {
                        return InstanceModel.STARTING;
                    }
                    case ProviderGCloudCompute.ST_RUNNING:
                    {
                        return InstanceModel.STARTED;
                    }
                    case ProviderGCloudCompute.ST_STOPPING:
                    {
                        return InstanceModel.STOPPING;
                    }
                    case ProviderGCloudCompute.ST_TERMINATED:
                    {
                        return InstanceModel.STOPPED;
                    }
                    default:
                    {
                        winston.error('[ProviderGCloudCompute] Error: Found unknown status:', status);

                        return InstanceModel.ERROR;
                    }
                }
            }
        }
    }

    createInstances(count) {
        const self = this;

        winston.debug('[ProviderGCloudCompute] createInstances: count=%d', count);

        return createInstances()
            .catch((err) => {
                throw err;
            })
        ;


        ////////////

        async function createInstances() {
            const names = Array(count).fill().map((a, index) => `${self._config.name}-${Math.random().toString(36).substring(2, 10)}`)
            let requests
            if (self._config.instance.region === 'random') {
                const availableZones = (await self._gc.getZones())[0].filter(zone => zone.metadata.status === 'UP').map(zone => zone.id)

                requests = names.map(name => {
                    const randomZone = availableZones[Math.floor(Math.random() * availableZones.length)]
                    const zone = self._gc.zone(randomZone)

                    return zone.createVM(name, {
                        os: `${self._config.projectId}/${self._config.instance.imageName}`,
                        tags: self._config.instance.tags.split(","),
                        machineType: self._config.instance.machineType,
                        http: true
                    })
                })
            } else {
                const zone = self._gc.zone(self._config.instance.region)

                requests = names.map(name => {
                    return zone.createVM(name, {
                        os: `${self._config.projectId}/${self._config.instance.imageName}`,
                        tags: self._config.instance.tags.split(","),
                        machineType: self._config.instance.machineType,
                        http: true
                    })
                })
            }

            return Promise.all(requests)
        }
    }


    startInstance(model) {
        winston.debug('[ProviderGCloudCompute] startInstance: model=', model.toString());
        const zone = this._gc.zone(model.region)
        const vm = zone.vm(model.name)

        return vm.start()
    }


    removeInstance(model) {
        winston.debug('[ProviderGCloudCompute] removeInstance: model=', model.toString());
        const zone = this._gc.zone(model.region)
        const vm = zone.vm(model.name)

        return vm.delete()
    }
};
