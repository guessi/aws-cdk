/* eslint-disable no-console*/
/* eslint-disable import/no-extraneous-dependencies */
import { SSM } from '@aws-sdk/client-ssm';
import { ExportReaderCRProps, CrossRegionExports } from '../types';
// Must use a require() otherwise esbuild complains
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pLimit: typeof import('p-limit') = require('p-limit');

export async function handler(event: AWSLambda.CloudFormationCustomResourceEvent) {
  const props: ExportReaderCRProps = event.ResourceProperties.ReaderProps;
  const imports: CrossRegionExports = props.imports as CrossRegionExports;
  const importNames = Object.keys(imports);
  const keyName: string = `aws-cdk:strong-ref:${props.prefix}`;

  const ssm = new SSM({ region: props.region });
  try {
    switch (event.RequestType) {
      case 'Create':
        console.info('Tagging SSM Parameter imports');
        await addTags(ssm, importNames, keyName);
        break;
      case 'Update':
        const oldProps: ExportReaderCRProps = event.OldResourceProperties.ReaderProps;
        const oldExports: CrossRegionExports = oldProps.imports as CrossRegionExports;
        const newExports = except(importNames, Object.keys(oldExports));
        const paramsToRelease = except(Object.keys(oldExports), importNames);
        console.info('Releasing unused SSM Parameter imports');
        if (Object.keys(paramsToRelease).length > 0) {
          await removeTags(ssm, paramsToRelease, keyName);
        }
        console.info('Tagging new SSM Parameter imports');
        await addTags(ssm, newExports, keyName);
        break;
      case 'Delete':
        console.info('Releasing all SSM Parameter exports by removing tags');
        await removeTags(ssm, importNames, keyName);
        return;
    }
  } catch (e) {
    console.error('Error importing cross region stack exports: ', e);
    throw e;
  }
  return {
    Data: imports,
  };
}

/**
 * Add tag to parameters for existing exports
 */
async function addTags(ssm: SSM, parameters: string[], keyName: string): Promise<void> {
  const limit = pLimit(10);
  // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
  await Promise.all(parameters.map((name) => limit(async () => {
    try {
      return await ssm.addTagsToResource({
        ResourceId: name,
        ResourceType: 'Parameter',
        Tags: [{
          Key: keyName,
          Value: 'true',
        }],
      });
    } catch (e) {
      throw new Error(`Error importing ${name}: ${e}`);
    }
  })));
}

/**
 * Remove tags from parameters
 */
async function removeTags(ssm: SSM, parameters: string[], keyName: string): Promise<void> {
  const limit = pLimit(10);
  // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
  await Promise.all(parameters.map(name => limit(async() => {
    try {
      return await ssm.removeTagsFromResource({
        TagKeys: [keyName],
        ResourceType: 'Parameter',
        ResourceId: name,
      });
    } catch (e: any) {
      if (e.name === 'InvalidResourceId') {
        return;
      } else {
        throw new Error(`Error releasing import ${name}: ${e}`);
      }
    }
  })));
}

/**
 * Return only the items from source that do not exist in the filter
 *
 * @param source the source object to perform the filter on
 * @param filter filter out items that exist in this object
 */
function except(source: string[], filter: string[]): string[] {
  return source.filter(key => !filter.includes(key));
}
