import { StackDeployment } from './stack-deployment';
import { StackSteps, Step } from './step';
import * as cdk from '../../../core';
import { ValidationError } from '../../../core';
import { CloudFormationStackArtifact } from '../../../cx-api';
import { isStackArtifact } from '../private/cloud-assembly-internals';
import { pipelineSynth } from '../private/construct-internals';

/**
 * Properties for a `StageDeployment`
 */
export interface StageDeploymentProps {
  /**
   * Stage name to use in the pipeline
   *
   * @default - Use Stage's construct ID
   */
  readonly stageName?: string;

  /**
   * Additional steps to run before any of the stacks in the stage
   *
   * @default - No additional steps
   */
  readonly pre?: Step[];

  /**
   * Additional steps to run after all of the stacks in the stage
   *
   * @default - No additional steps
   */
  readonly post?: Step[];

  /**
   * Instructions for additional steps that are run at the stack level
   *
   * @default - No additional instructions
   */
  readonly stackSteps?: StackSteps[];
}

/**
 * Deployment of a single `Stage`
 *
 * A `Stage` consists of one or more `Stacks`, which will be
 * deployed in dependency order.
 */
export class StageDeployment {
  /**
   * Create a new `StageDeployment` from a `Stage`
   *
   * Synthesizes the target stage, and deployes the stacks found inside
   * in dependency order.
   */
  public static fromStage(stage: cdk.Stage, props: StageDeploymentProps = {}) {
    const assembly = pipelineSynth(stage);
    if (assembly.stacks.length === 0) {
      // If we don't check here, a more puzzling "stage contains no actions"
      // error will be thrown come deployment time.
      throw new ValidationError(`The given Stage construct ('${stage.node.path}') should contain at least one Stack`, stage);
    }

    const stepFromArtifact = new Map<CloudFormationStackArtifact, StackDeployment>();
    for (const artifact of assembly.stacks) {
      if (artifact.assumeRoleAdditionalOptions?.Tags && artifact.assumeRoleArn) {
        throw new ValidationError(`Deployment of stack ${artifact.stackName} requires assuming the role ${artifact.assumeRoleArn} with session tags, but assuming roles with session tags is not supported by CodePipeline.`, stage);
      }
      const step = StackDeployment.fromArtifact(artifact);
      stepFromArtifact.set(artifact, step);
    }
    if (props.stackSteps) {
      for (const stackstep of props.stackSteps) {
        const stackArtifact = assembly.getStackArtifact(stackstep.stack.artifactId);
        const thisStep = stepFromArtifact.get(stackArtifact);
        if (!thisStep) {
          throw new ValidationError('Logic error: we just added a step for this artifact but it disappeared.', stage);
        }
        thisStep.addStackSteps(stackstep.pre ?? [], stackstep.changeSet ?? [], stackstep.post ?? []);
      }
    }

    for (const artifact of assembly.stacks) {
      const thisStep = stepFromArtifact.get(artifact);
      if (!thisStep) {
        throw new ValidationError('Logic error: we just added a step for this artifact but it disappeared.', stage);
      }

      const stackDependencies = artifact.dependencies.filter(isStackArtifact);
      for (const dep of stackDependencies) {
        const depStep = stepFromArtifact.get(dep);
        if (!depStep) {
          throw new ValidationError(`Stack '${artifact.id}' depends on stack not found in same Stage: '${dep.id}'`, stage);
        }
        thisStep.addStackDependency(depStep);
      }
    }

    return new StageDeployment(Array.from(stepFromArtifact.values()), {
      stageName: stage.stageName,
      ...props,
    });
  }

  /**
   * The display name of this stage
   */
  public readonly stageName: string;

  /**
   * Additional steps that are run before any of the stacks in the stage
   */
  public readonly pre: Step[];

  /**
   * Additional steps that are run after all of the stacks in the stage
   */
  public readonly post: Step[];

  /**
   * Instructions for additional steps that are run at stack level
   */
  public readonly stackSteps: StackSteps[];

  /**
   * Determine if all stacks in stage should be deployed with prepare
   * step or not.
   */
  public readonly prepareStep?: boolean;

  private constructor(
    /** The stacks deployed in this stage */
    public readonly stacks: StackDeployment[], props: StageDeploymentProps = {}) {
    this.stageName = props.stageName ?? '';
    this.pre = props.pre ?? [];
    this.post = props.post ?? [];
    this.stackSteps = props.stackSteps ?? [];
  }

  /**
   * Add an additional step to run before any of the stacks in this stage
   */
  public addPre(...steps: Step[]) {
    this.pre.push(...steps);
  }

  /**
   * Add an additional step to run after all of the stacks in this stage
   */
  public addPost(...steps: Step[]) {
    this.post.push(...steps);
  }
}
