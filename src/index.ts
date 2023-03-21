import {run, Args, Command, Flags} from '@oclif/core';
import { migrator } from 'etcher-sdk';

export default class Migrator extends Command {
	static description = 'Migrate this device to balenaOS';

	static examples = [
		'> migrate \\Users\\Bob\\balenaos.img',
	];

	static args = {
		sourceImagePath: Args.string({description: 'balenaOS image path', required: true}),
	};

	static flags = {};

	async run(): Promise<void> {
		const {args, flags} = await this.parse(Migrator)
		const winPartition = "C";
		const deviceName = "\\\\.\\PhysicalDrive0";
		const efiLabel = "M";

		migrator.migrate(args.sourceImagePath, winPartition, deviceName, efiLabel)
			.then(console.log)
			.catch(console.log);
  }
}
