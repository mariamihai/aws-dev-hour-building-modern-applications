#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { AwsDevHourBuildingModernApplicationsStack } from '../lib/aws-dev-hour-building-modern-applications-stack';

const app = new cdk.App();

// Can add multiple stacks, for different development environments and accounts or regions
new AwsDevHourBuildingModernApplicationsStack(app, 'AwsDevHourBuildingModernApplicationsStack', {
   env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

  // env: { account: '<account>', region: '<region>' },
});