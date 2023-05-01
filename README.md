# migrator

Command line interface (CLI) to migrate a computer to run balenaOS.

**WARNING This tool will overwrite the operating system and all data on the computer that runs it.** Be sure to save any important data before using the migrator.

## About

The migrator provides a command prompt / terminal window to run etcher SDK's [migrator function](https://github.com/balena-io-modules/etcher-sdk/tree/master/lib/migrator). The migrator is an [open-source project on
GitHub](https://github.com/balena-os/migrator/), and your contributions are welcome!

Presently supports migration only from a computer running Windows 10 on UEFI based firmware.

## Installation and Building

Clone the migrator repository, install the node modules and build it as shown below.

```
> git clone https://github.com/balena-os/migrator.git
> cd migrator
> npm install
> npm run build
> npm run pkg
```
These commands generate a single-file executable `migrator.exe` in the `dist` directory.

## Command reference documentation
### Preconfigure Flasher Image
You need a balenaOS image for your device type. See the downloads [page](https://www.balena.io/os) to retrieve the `<flasher-image-archive>` file. Run the commands below to configure the image. See the balenaCLI [documentation](https://docs.balena.io/reference/balena-cli/#os-configure-image) for details of the `os configure` command.

```
  unzip <flasher-image-archive>
  balena os configure <flasher-image> --fleet <fleet-slug> --version <os-version>
```

### Migrator
The command below prepares the migration, and then reboots to execute it and launch balenaOS.
```
  migrator -i <value> [-y]

FLAGS
  -i, --image=<value>    (required) balenaOS flasher image path name
  -y, --non-interactive  no user input; use defaults
```
Since the migrator executes a destructive operation, it first prompts you to confirm. Use the `--non-interactive` option to avoid the prompt and begin the migration immediately.

## License

The project is licensed under the [Apache 2.0 License](https://www.apache.org/licenses/LICENSE-2.0).
A copy is also available in the LICENSE file in this repository.
